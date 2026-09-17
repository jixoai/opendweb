//! iroh relay 服务端嵌入：为无法直连的 fabric 节点提供桥接。
//! 端口拓扑（design D1）：DWEB_GATEWAY_BIND（gateway：rendezvous+healthz+services.json）、
//! DWEB_RELAY_HTTP_BIND（relay 控制面/WS 桥接，明文本地可用）、
//! DWEB_RELAY_QUIC_BIND（relay 数据面，需要 TLS，v0.1 默认关闭）。
//! 启用与绑定由 main 统一解析（flag > env > default）后传入。
//!
//! 访问控制接线（task 1.5，design §8.2）：`access: Option<Arc<AccessGate>>`——
//! None（open 模式）保持 iroh-relay 默认 AllowAll 快路径零开销；Some 则装配
//! [`RelayAccessControl`]（on_connect 走 C0/L1/L1b/L2 验证链；deny reason 经
//! iroh-relay 握手协议原样回传客户端，handshake.rs deny 路径）。
//! 限流接线（task 1.7）：`client_rx` 字节率透传 iroh-relay 已实现的
//! `Limits::client_rx`（连接数类限额上游标注未实现，不承诺）；限流语义与
//! access mode 正交（open 模式同样生效）。

use crate::access::gate::{AccessGate, GateDecision, GateInput, Op};
use anyhow::{Context, Result};
use iroh_base::EndpointId;
use iroh_relay::server::{
    Access, AccessControl, ClientRateLimit, ClientRequest, ConnectionId,
    RelayConfig as RelayServerConfig, Server, ServerConfig,
};
use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::sync::Arc;

/// 构造并启动 relay。返回 None 表示未启用。
///
/// - `http_bind`：relay HTTP 监听地址（默认 0.0.0.0:3340，由 main 解析）
/// - `quic_bind`：可选；QUIC 数据面需要 TLS 配置，未提供证书时跳过并告警
/// - `access`：`restricted` 模式的验证链聚合器；None = open 模式 AllowAll
/// - `client_rx`：每客户端接收字节率上限（DWEB_RELAY_CLIENT_RX，可选）
pub async fn start(
    enabled: bool,
    http_bind: SocketAddr,
    quic_bind: Option<SocketAddr>,
    access: Option<Arc<AccessGate>>,
    client_rx: Option<NonZeroU32>,
) -> Result<Option<Server>> {
    if !enabled {
        tracing::info!("relay disabled");
        return Ok(None);
    }

    let mut relay = RelayServerConfig::new(http_bind);
    relay.tls = None; // 生产由反代终结 TCP/WS；QUIC 需原生证书（见下）
    if let Some(gate) = access {
        relay.access = Arc::new(RelayAccessControl { gate });
    }
    if let Some(bytes_per_second) = client_rx {
        relay.limits.client_rx = Some(ClientRateLimit::new(bytes_per_second));
    }

    let mut config = ServerConfig::default();
    if let Some(quic_bind) = quic_bind {
        if relay.tls.is_none() {
            tracing::warn!(
                "DWEB_RELAY_QUIC_BIND is set but no TLS config is present; \
                 QUIC data plane not enabled (plaintext QUIC unavailable)"
            );
        } else {
            config.quic = Some(iroh_relay::server::QuicConfig::new(quic_bind));
        }
    }
    config.relay = Some(relay);

    let server = Server::spawn(config)
        .await
        .context("spawn iroh relay server")?;
    let url = server
        .http_addr()
        .map(|a| format!("http://{a}"))
        .unwrap_or_else(|| "<unknown>".into());
    tracing::info!("iroh relay listening on {url}");
    Ok(Some(server))
}

/// iroh-relay AccessControl 适配层：从 [`ClientRequest`] 抽取原始凭证要素
/// 交 [`AccessGate`]，deny reason 原样透传（Option<String>）。
pub struct RelayAccessControl {
    gate: Arc<AccessGate>,
}

impl std::fmt::Debug for RelayAccessControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayAccessControl")
            .field("gate", &self.gate)
            .finish()
    }
}

/// iroh-relay `?token=` query 参数名（同其 pub(crate) 的
/// AUTH_TOKEN_URL_QUERY_PARAM，不可导入故本地冻结）
const TOKEN_QUERY_PARAM: &str = "token";

impl RelayAccessControl {
    /// 从 ClientRequest 抽取验证链输入。R4 P1-6（design §8.2 C0）：
    /// **直接读 Authorization header 原始字节与 ?token= query**，不复用
    /// `auth_token()`——它对非法 UTF-8 header 返回 None，会把「坏票」
    /// 误降级为「无票」混入 A_cb 动态名单。非 UTF-8 在此 lossy 转换：
    /// U+FFFD 恒不过 dwebr1./base64url 白名单，必落 malformed。
    /// 多 Authorization header 取首个（HeaderMap::get 语义；病态重复头
    /// 不构成合法凭证形态）。
    fn gate_input(request: &ClientRequest) -> GateInput {
        let auth_header = request
            .headers()
            .get(axum::http::header::AUTHORIZATION)
            .map(|value| match value.to_str() {
                Ok(s) => s.to_owned(),
                Err(_) => String::from_utf8_lossy(value.as_bytes()).into_owned(),
            });
        let query_token = request
            .query_pairs()
            .find(|(name, _)| name == TOKEN_QUERY_PARAM)
            .map(|(_, value)| value.into_owned());
        GateInput {
            endpoint_id: *request.endpoint_id().as_bytes(),
            auth_header,
            query_token,
            connection_id: connection_id_u64(request.connection_id()),
            op: Op::RelayConnect,
        }
    }
}

/// ConnectionId（私有大端 u64 的 Display 形态）→ u64（webhook payload 关联键）
fn connection_id_u64(id: ConnectionId) -> u64 {
    id.to_string().parse().unwrap_or(u64::MAX)
}

impl AccessControl for RelayAccessControl {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        let input = Self::gate_input(request);
        match self.gate.decide(&input).await {
            GateDecision::Allow => Access::Allow,
            GateDecision::Deny(reason) => Access::Deny {
                reason: Some(reason.into_owned()),
            },
        }
    }

    fn on_disconnect(&self, endpoint_id: EndpointId, connection_id: ConnectionId) {
        // callback 模式：best-effort 观察通知（不阻塞不重试）；static 空实现
        self.gate
            .on_disconnect(*endpoint_id.as_bytes(), connection_id_u64(connection_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::cap::{CAP_RELAY, sign_and_encode};
    use crate::access::config::PolicyConfig;
    use crate::access::registry::OwnerRegistry;
    use axum::http::request::Parts;
    use ed25519_dalek::SigningKey;
    use iroh_base::PublicKey;
    use iroh_relay::http::ProtocolVersion;
    use tempfile::TempDir;

    struct Fixture {
        issuer: SigningKey,
        server_id: [u8; 32],
        fabric_id: [u8; 32],
        /// 握手认证身份（合法 PublicKey——ClientRequest 构造要求曲线点合法）
        recipient: PublicKey,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                issuer: SigningKey::from_bytes(&[1u8; 32]),
                server_id: [2u8; 32],
                fabric_id: [3u8; 32],
                recipient: iroh_base::SecretKey::from_bytes(&[4u8; 32]).public(),
            }
        }

        fn token(&self) -> String {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            sign_and_encode(
                &self.issuer,
                &self.fabric_id,
                &self.server_id,
                self.recipient.as_bytes(),
                CAP_RELAY,
                now,
                now + 3_600_000,
            )
        }

        fn gate(&self, registry: Arc<OwnerRegistry>) -> Arc<AccessGate> {
            Arc::new(AccessGate::new(self.server_id, registry, PolicyConfig::Static).unwrap())
        }
    }

    /// 构造 ClientRequest（iroh-relay ClientRequest::new 为公开 API：
    /// endpoint_id + protocol_version + http::request::Parts）
    fn client_request(endpoint: &PublicKey, uri: &str, auth_header: Option<&str>) -> ClientRequest {
        let mut builder = axum::http::Request::builder().uri(uri);
        if let Some(header) = auth_header {
            builder = builder.header(axum::http::header::AUTHORIZATION, header);
        }
        let req = builder.body(()).unwrap();
        let parts: Parts = req.into_parts().0;
        ClientRequest::new(*endpoint, ProtocolVersion::V2, parts)
    }

    fn access_reason(access: &Access) -> Option<String> {
        match access {
            Access::Allow => None,
            Access::Deny { reason } => reason.clone(),
        }
    }

    fn registered_registry(f: &Fixture) -> Arc<OwnerRegistry> {
        let dir = TempDir::new().unwrap();
        let registry = Arc::new(OwnerRegistry::load(&dir.path().join("owners.jsonl")).unwrap());
        registry
            .register(&f.fabric_id, &f.issuer.verifying_key().to_bytes())
            .unwrap();
        registry
    }

    #[tokio::test]
    async fn on_connect_valid_bearer_token_allows() {
        let f = Fixture::new();
        let ctl = RelayAccessControl {
            gate: f.gate(registered_registry(&f)),
        };
        let req = client_request(
            &f.recipient,
            "/relay",
            Some(&format!("Bearer {}", f.token())),
        );
        assert_eq!(ctl.on_connect(&req).await, Access::Allow);
    }

    #[tokio::test]
    async fn on_connect_query_token_allows() {
        let f = Fixture::new();
        let ctl = RelayAccessControl {
            gate: f.gate(registered_registry(&f)),
        };
        let req = client_request(&f.recipient, &format!("/relay?token={}", f.token()), None);
        assert_eq!(ctl.on_connect(&req).await, Access::Allow);
    }

    #[tokio::test]
    async fn on_connect_no_credential_static_denies() {
        let f = Fixture::new();
        let ctl = RelayAccessControl {
            gate: f.gate(registered_registry(&f)),
        };
        let req = client_request(&f.recipient, "/relay", None);
        let access = ctl.on_connect(&req).await;
        assert_eq!(
            access_reason(&access).as_deref(),
            Some("dweb/no-capability")
        );
    }

    #[tokio::test]
    async fn on_connect_bad_bearer_is_malformed_not_no_capability() {
        // R4 P1-6：坏票绝不降级无票（auth_token() 归一化陷阱的回归）
        let f = Fixture::new();
        let ctl = RelayAccessControl {
            gate: f.gate(registered_registry(&f)),
        };
        for header in ["Basic xyz", "Bearer ", "Bearer dwebr2.aa"] {
            let req = client_request(&f.recipient, "/relay", Some(header));
            let access = ctl.on_connect(&req).await;
            assert_eq!(
                access_reason(&access).as_deref(),
                Some("dweb/malformed-capability"),
                "header {header}"
            );
        }
    }

    #[tokio::test]
    async fn on_connect_non_utf8_header_bytes_are_malformed() {
        // HeaderValue 非法 UTF-8 → lossy → malformed（不经 auth_token 的
        // None 归一化路径）
        let f = Fixture::new();
        let ctl = RelayAccessControl {
            gate: f.gate(registered_registry(&f)),
        };
        let req = axum::http::Request::builder()
            .uri("/relay")
            .header(
                axum::http::header::AUTHORIZATION,
                axum::http::HeaderValue::from_bytes(&[0x81, 0x82, 0x83]).unwrap(),
            )
            .body(())
            .unwrap();
        let parts = req.into_parts().0;
        let cr = ClientRequest::new(f.recipient, ProtocolVersion::V2, parts);
        let access = ctl.on_connect(&cr).await;
        assert_eq!(
            access_reason(&access).as_deref(),
            Some("dweb/malformed-capability")
        );
    }

    #[tokio::test]
    async fn on_connect_not_recipient_denies() {
        // A2：窃取令牌串、从自己的 endpoint 接入
        let f = Fixture::new();
        let ctl = RelayAccessControl {
            gate: f.gate(registered_registry(&f)),
        };
        let attacker = iroh_base::SecretKey::from_bytes(&[0xEE; 32]).public();
        let req = client_request(&attacker, "/relay", Some(&format!("Bearer {}", f.token())));
        let access = ctl.on_connect(&req).await;
        assert_eq!(
            access_reason(&access).as_deref(),
            Some("dweb/not-recipient")
        );
    }

    #[tokio::test]
    async fn on_disconnect_static_is_noop() {
        let f = Fixture::new();
        let ctl = RelayAccessControl {
            gate: f.gate(registered_registry(&f)),
        };
        // ConnectionId 无公开构造器（进程内自增）：借 ClientRequest::new 派发
        let cr = client_request(&f.recipient, "/relay", None);
        ctl.on_disconnect(f.recipient, cr.connection_id());
    }
}
