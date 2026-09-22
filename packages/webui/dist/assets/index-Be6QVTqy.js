(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))r(s);new MutationObserver(s=>{for(const o of s)if(o.type==="childList")for(const a of o.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&r(a)}).observe(document,{childList:!0,subtree:!0});function n(s){const o={};return s.integrity&&(o.integrity=s.integrity),s.referrerPolicy&&(o.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?o.credentials="include":s.crossOrigin==="anonymous"?o.credentials="omit":o.credentials="same-origin",o}function r(s){if(s.ep)return;s.ep=!0;const o=n(s);fetch(s.href,o)}})();var $e,w,it,B,Ve,at,lt,Fe,ie,te,ct,Pe,Ae,De,de={},_e=[],jt=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,me=Array.isArray;function H(e,t){for(var n in t)e[n]=t[n];return e}function Ie(e){e&&e.parentNode&&e.parentNode.removeChild(e)}function ut(e,t,n){var r,s,o,a={};for(o in t)o=="key"?r=t[o]:o=="ref"?s=t[o]:a[o]=t[o];if(arguments.length>2&&(a.children=arguments.length>3?$e.call(arguments,2):n),typeof e=="function"&&e.defaultProps!=null)for(o in e.defaultProps)a[o]===void 0&&(a[o]=e.defaultProps[o]);return ae(e,a,r,s,null)}function ae(e,t,n,r,s){var o={type:e,props:t,key:n,ref:r,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:s??++it,__i:-1,__u:0};return s==null&&w.vnode!=null&&w.vnode(o),o}function be(e){return e.children}function le(e,t){this.props=e,this.context=t}function z(e,t){if(t==null)return e.__?z(e.__,e.__i+1):null;for(var n;t<e.__k.length;t++)if((n=e.__k[t])!=null&&n.__e!=null)return n.__e;return typeof e.type=="function"?z(e):null}function qt(e){if(e.__P&&e.__d){var t=e.__v,n=t.__e,r=[],s=[],o=H({},t);o.__v=t.__v+1,w.vnode&&w.vnode(o),Le(e.__P,o,t,e.__n,e.__P.namespaceURI,32&t.__u?[n]:null,r,n??z(t),!!(32&t.__u),s),o.__v=t.__v,o.__.__k[o.__i]=o,ht(r,o,s),t.__e=t.__=null,o.__e!=n&&dt(o)}}function dt(e){if((e=e.__)!=null&&e.__c!=null)return e.__e=e.__c.base=null,e.__k.some(function(t){if(t!=null&&t.__e!=null)return e.__e=e.__c.base=t.__e}),dt(e)}function Je(e){(!e.__d&&(e.__d=!0)&&B.push(e)&&!pe.__r++||Ve!=w.debounceRendering)&&((Ve=w.debounceRendering)||at)(pe)}function pe(){try{for(var e,t=1;B.length;)B.length>t&&B.sort(lt),e=B.shift(),t=B.length,qt(e)}finally{B.length=pe.__r=0}}function _t(e,t,n,r,s,o,a,c,d,l,_){var h,i,p,m,k,b,y=r&&r.__k||_e,$=t.length;for(d=Vt(n,t,y,d,$),h=0;h<$;h++)(p=n.__k[h])!=null&&(i=p.__i!=-1&&y[p.__i]||de,p.__i=h,b=Le(e,p,i,s,o,a,c,d,l,_),m=p.__e,p.ref&&i.ref!=p.ref&&(i.ref&&Re(i.ref,null,p),_.push(p.ref,p.__c||m,p)),k==null&&m!=null&&(k=m),4&p.__u?(d=pt(p,d,e),i.__e&&(i.__e=null)):typeof p.type=="function"&&b!==void 0?d=b:m&&(d=m.nextSibling),p.__u&=-7);return n.__e=k,d}function Vt(e,t,n,r,s){var o,a,c,d,l,_=n.length,h=_,i=0;for(e.__k=new Array(s),o=0;o<s;o++)(a=t[o])!=null&&typeof a!="boolean"&&typeof a!="function"?(typeof a=="string"||typeof a=="number"||typeof a=="bigint"||a.constructor==String?a=e.__k[o]=ae(null,a,null,null,null):me(a)?a=e.__k[o]=ae(be,{children:a},null,null,null):a.constructor===void 0&&a.__b>0?a=e.__k[o]=ae(a.type,a.props,a.key,a.ref?a.ref:null,a.__v):e.__k[o]=a,d=o+i,a.__=e,a.__b=e.__b+1,c=null,(l=a.__i=Jt(a,n,d,h))!=-1&&(h--,(c=n[l])&&(c.__u|=2)),c==null||c.__v==null?(l==-1&&(s>_?i--:s<_&&i++),typeof a.type!="function"&&(a.__u|=4)):l!=d&&(l==d-1?i--:l==d+1?i++:(l>d?i--:i++,a.__u|=4))):e.__k[o]=null;if(h)for(o=0;o<_;o++)(c=n[o])!=null&&(2&c.__u)==0&&(c.__e==r&&(r=z(c)),$t(c,c));return r}function pt(e,t,n){var r,s;if(typeof e.type=="function"){for(r=e.__k,s=0;r&&s<r.length;s++)r[s]&&(r[s].__=e,t=pt(r[s],t,n));return t}e.__e!=t&&(t&&e.type&&!t.parentNode&&(t=z(e)),t=n.insertBefore(e.__e,t||null));do t=t&&t.nextSibling;while(t!=null&&t.nodeType==8);return t}function Jt(e,t,n,r){var s,o,a,c=e.key,d=e.type,l=t[n],_=l!=null&&(2&l.__u)==0;if(l===null&&c==null||_&&c==l.key&&d==l.type)return n;if(r>(_?1:0)){for(s=n-1,o=n+1;s>=0||o<t.length;)if((l=t[a=s>=0?s--:o++])!=null&&(2&l.__u)==0&&c==l.key&&d==l.type)return a}return-1}function ze(e,t,n){t[0]=="-"?e.setProperty(t,n??""):e[t]=n==null?"":typeof n!="number"||jt.test(t)?n:n+"px"}function re(e,t,n,r,s){var o,a;e:if(t=="style")if(typeof n=="string")e.style.cssText=n;else{if(typeof r=="string"&&(e.style.cssText=r=""),r)for(t in r)n&&t in n||ze(e.style,t,"");if(n)for(t in n)r&&n[t]==r[t]||ze(e.style,t,n[t])}else if(t[0]=="o"&&t[1]=="n")o=t!=(t=t.replace(ct,"$1")),a=t.toLowerCase(),t=a in e||t=="onFocusOut"||t=="onFocusIn"?a.slice(2):t.slice(2),e.l||(e.l={}),e.l[t+o]=n,n?r?n[te]=r[te]:(n[te]=Pe,e.addEventListener(t,o?De:Ae,o)):e.removeEventListener(t,o?De:Ae,o);else{if(s=="http://www.w3.org/2000/svg")t=t.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(t!="width"&&t!="height"&&t!="href"&&t!="list"&&t!="form"&&t!="tabIndex"&&t!="download"&&t!="rowSpan"&&t!="colSpan"&&t!="role"&&t!="popover"&&t in e)try{e[t]=n??"";break e}catch{}typeof n=="function"||(n==null||n===!1&&t[4]!="-"?e.removeAttribute(t):e.setAttribute(t,t=="popover"&&n==1?"":n))}}function Ge(e){return function(t){if(this.l){var n=this.l[t.type+e];if(t[ie]==null)t[ie]=Pe++;else if(t[ie]<n[te])return;return n(w.event?w.event(t):t)}}}function Le(e,t,n,r,s,o,a,c,d,l){var _,h,i,p,m,k,b,y,$,T,N,F,D,v,U,G,A=t.type;if(t.constructor!==void 0)return null;128&n.__u&&(d=!!(32&n.__u),o=[c=t.__e=n.__e]),(_=w.__b)&&_(t);e:if(typeof A=="function"){h=a.length;try{if($=t.props,T=A.prototype&&A.prototype.render,N=(_=A.contextType)&&r[_.__c],F=_?N?N.props.value:_.__:r,n.__c?y=(i=t.__c=n.__c).__=i.__E:(T?t.__c=i=new A($,F):(t.__c=i=new le($,F),i.constructor=A,i.render=Gt),N&&N.sub(i),i.state||(i.state={}),i.__n=r,p=i.__d=!0,i.__h=[],i._sb=[]),T&&i.__s==null&&(i.__s=i.state),T&&A.getDerivedStateFromProps!=null&&(i.__s==i.state&&(i.__s=H({},i.__s)),H(i.__s,A.getDerivedStateFromProps($,i.__s))),m=i.props,k=i.state,i.__v=t,p)T&&A.getDerivedStateFromProps==null&&i.componentWillMount!=null&&i.componentWillMount(),T&&i.componentDidMount!=null&&i.__h.push(i.componentDidMount);else{if(T&&A.getDerivedStateFromProps==null&&$!==m&&i.componentWillReceiveProps!=null&&i.componentWillReceiveProps($,F),t.__v==n.__v||!i.__e&&i.shouldComponentUpdate!=null&&i.shouldComponentUpdate($,i.__s,F)===!1){t.__v!=n.__v&&(i.props=$,i.state=i.__s,i.__d=!1),t.__e=n.__e,t.__k=n.__k,t.__k.some(function(I){I&&(I.__=t)}),_e.push.apply(i.__h,i._sb),i._sb=[],i.__h.length&&a.push(i),c=z(n);break e}i.componentWillUpdate!=null&&i.componentWillUpdate($,i.__s,F),T&&i.componentDidUpdate!=null&&i.__h.push(function(){i.componentDidUpdate(m,k,b)})}if(i.context=F,i.props=$,i.__P=e,i.__e=!1,D=w.__r,v=0,T)i.state=i.__s,i.__d=!1,D&&D(t),_=i.render(i.props,i.state,i.context),_e.push.apply(i.__h,i._sb),i._sb=[];else do i.__d=!1,D&&D(t),_=i.render(i.props,i.state,i.context),i.state=i.__s;while(i.__d&&++v<25);i.state=i.__s,i.getChildContext!=null&&(r=H(H({},r),i.getChildContext())),T&&!p&&i.getSnapshotBeforeUpdate!=null&&(b=i.getSnapshotBeforeUpdate(m,k)),U=_!=null&&_.type===be&&_.key==null?vt(_.props.children):_,c=_t(e,me(U)?U:[U],t,n,r,s,o,a,c,d,l),i.base=t.__e,t.__u&=-161,i.__h.length&&a.push(i),y&&(i.__E=i.__=null)}catch(I){if(a.length=h,t.__v=null,d||o!=null){if(I.then){for(t.__u|=d?160:128;c&&c.nodeType==8&&c.nextSibling;)c=c.nextSibling;o!=null&&(o[o.indexOf(c)]=null),t.__e=c}else if(o!=null)for(G=o.length;G--;)Ie(o[G])}else t.__e=n.__e;t.__k==null&&(t.__k=n.__k||[]),I.then||ft(t),w.__e(I,t,n)}}else o==null&&t.__v==n.__v?(t.__k=n.__k,t.__e=n.__e):c=t.__e=zt(n.__e,t,n,r,s,o,a,d,l);return(_=w.diffed)&&_(t),128&t.__u?void 0:c}function ft(e){e&&(e.__c&&(e.__c.__e=!0),e.__k&&e.__k.some(ft))}function ht(e,t,n){for(var r=0;r<n.length;r++)Re(n[r],n[++r],n[++r]);w.__c&&w.__c(t,e),e.some(function(s){try{e=s.__h,s.__h=[],e.some(function(o){o.call(s)})}catch(o){w.__e(o,s.__v)}})}function vt(e){return typeof e!="object"||e==null||e.__b>0?e:me(e)?e.map(vt):e.constructor!==void 0?null:H({},e)}function zt(e,t,n,r,s,o,a,c,d){var l,_,h,i,p,m,k,b=n.props||de,y=t.props,$=t.type;if($=="svg"?s="http://www.w3.org/2000/svg":$=="math"?s="http://www.w3.org/1998/Math/MathML":s||(s="http://www.w3.org/1999/xhtml"),o!=null){for(l=0;l<o.length;l++)if((p=o[l])&&"setAttribute"in p==!!$&&($?p.localName==$:p.nodeType==3)){e=p,o[l]=null;break}}if(e==null){if($==null)return document.createTextNode(y);e=document.createElementNS(s,$,y.is&&y),c&&(w.__m&&w.__m(t,o),c=!1),o=null}if($==null)b===y||c&&e.data==y||(e.data=y);else{if(o=$=="textarea"&&y.defaultValue!=null?null:o&&$e.call(e.childNodes),!c&&o!=null)for(b={},l=0;l<e.attributes.length;l++)b[(p=e.attributes[l]).name]=p.value;for(l in b)p=b[l],l=="dangerouslySetInnerHTML"?h=p:l=="children"||l in y||l=="value"&&"defaultValue"in y||l=="checked"&&"defaultChecked"in y||re(e,l,null,p,s);for(l in y)p=y[l],l=="children"?i=p:l=="dangerouslySetInnerHTML"?_=p:l=="value"?m=p:l=="checked"?k=p:c&&typeof p!="function"||b[l]===p||re(e,l,p,b[l],s);if(_)c||h&&(_.__html==h.__html||_.__html==e.innerHTML)||(e.innerHTML=_.__html),t.__k=[];else if(h&&(e.innerHTML=""),_t(t.type=="template"?e.content:e,me(i)?i:[i],t,n,r,$=="foreignObject"?"http://www.w3.org/1999/xhtml":s,o,a,o?o[0]:n.__k&&z(n,0),c,d),o!=null)for(l=o.length;l--;)Ie(o[l]);c&&$!="textarea"||(l="value",$=="progress"&&m==null?e.removeAttribute("value"):m!=null&&(m!==e[l]||$=="progress"&&!m||$=="option"&&m!=b[l])&&re(e,l,m,b[l],s),l="checked",k!=null&&k!=e[l]&&re(e,l,k,b[l],s))}return e}function Re(e,t,n){try{if(typeof e=="function"){var r=typeof e.__u=="function";r&&e.__u(),r&&t==null||(e.__u=e(t))}else e.current=t}catch(s){w.__e(s,n)}}function $t(e,t,n){var r,s;if(w.unmount&&w.unmount(e),(r=e.ref)&&(r.current&&r.current!=e.__e||Re(r,null,t)),(r=e.__c)!=null){if(r.componentWillUnmount)try{r.componentWillUnmount()}catch(o){w.__e(o,t)}r.base=r.__P=r.__n=null}if(r=e.__k)for(s=0;s<r.length;s++)r[s]&&$t(r[s],t,n||typeof e.type!="function");n||Ie(e.__e),e.__c=e.__=e.__e=void 0}function Gt(e,t,n){return this.constructor(e,n)}function Kt(e,t,n){var r,s,o,a;t==document&&(t=document.documentElement),w.__&&w.__(e,t),s=(r=!1)?null:t.__k,o=[],a=[],Le(t,e=t.__k=ut(be,null,[e]),s||de,de,t.namespaceURI,s?null:t.firstChild?$e.call(t.childNodes):null,o,s?s.__e:t.firstChild,r,a),ht(o,e,a),e.props.children=null}$e=_e.slice,w={__e:function(e,t,n,r){for(var s,o,a;t=t.__;)if((s=t.__c)&&!s.__)try{if((o=s.constructor)&&o.getDerivedStateFromError!=null&&(s.setState(o.getDerivedStateFromError(e)),a=s.__d),s.componentDidCatch!=null&&(s.componentDidCatch(e,r||{}),a=s.__d),a)return s.__E=s}catch(c){e=c}throw e}},it=0,le.prototype.setState=function(e,t){var n;n=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=H({},this.state),typeof e=="function"&&(e=e(H({},n),this.props)),e&&H(n,e),e!=null&&this.__v&&(t&&this._sb.push(t),Je(this))},le.prototype.forceUpdate=function(e){this.__v&&(this.__e=!0,e&&this.__h.push(e),Je(this))},le.prototype.render=be,B=[],at=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,lt=function(e,t){return e.__v.__b-t.__v.__b},pe.__r=0,Fe=Math.random().toString(8),ie="__d"+Fe,te="__a"+Fe,ct=/(PointerCapture)$|Capture$/i,Pe=0,Ae=Ge(!1),De=Ge(!0);var mt=function(e,t,n,r){var s;t[0]=0;for(var o=1;o<t.length;o++){var a=t[o++],c=t[o]?(t[0]|=a?1:2,n[t[o++]]):t[++o];a===3?r[0]=c:a===4?r[1]=Object.assign(r[1]||{},c):a===5?(r[1]=r[1]||{})[t[++o]]=c:a===6?r[1][t[++o]]+=c+"":a?(s=e.apply(c,mt(e,c,n,["",null])),r.push(s),c[0]?t[0]|=2:(t[o-2]=0,t[o]=s)):r.push(c)}return r},Ke=new Map;function Qt(e){var t=Ke.get(this);return t||(t=new Map,Ke.set(this,t)),(t=mt(this,t.get(e)||(t.set(e,t=(function(n){for(var r,s,o=1,a="",c="",d=[0],l=function(i){o===1&&(i||(a=a.replace(/^\s*\n\s*|\s*\n\s*$/g,"")))?d.push(0,i,a):o===3&&(i||a)?(d.push(3,i,a),o=2):o===2&&a==="..."&&i?d.push(4,i,0):o===2&&a&&!i?d.push(5,0,!0,a):o>=5&&((a||!i&&o===5)&&(d.push(o,0,a,s),o=6),i&&(d.push(o,i,0,s),o=6)),a=""},_=0;_<n.length;_++){_&&(o===1&&l(),l(_));for(var h=0;h<n[_].length;h++)r=n[_][h],o===1?r==="<"?(l(),d=[d],o=3):a+=r:o===4?a==="--"&&r===">"?(o=1,a=""):a=r+a[0]:c?r===c?c="":a+=r:r==='"'||r==="'"?c=r:r===">"?(l(),o=1):o&&(r==="="?(o=5,s=a,a=""):r==="/"&&(o<5||n[_][h+1]===">")?(l(),o===3&&(d=d[0]),o=d,(d=d[0]).push(2,0,o),o=0):r===" "||r==="	"||r===`
`||r==="\r"?(l(),o=2):a+=r),o===3&&a==="!--"&&(o=4,d=d[0])}return l(),d})(e)),t),arguments,[])).length>1?t:t[0]}const u=Qt.bind(ut);var ne,S,Oe,Qe,fe=0,bt=[],x=w,Xe=x.__b,Ye=x.__r,Ze=x.diffed,et=x.__c,tt=x.unmount,nt=x.__;function He(e,t){x.__h&&x.__h(S,e,fe||t),fe=0;var n=S.__H||(S.__H={__:[],__h:[]});return e>=n.__.length&&n.__.push({}),n.__[e]}function C(e){return fe=1,Xt(gt,e)}function Xt(e,t,n){var r=He(ne++,2);if(r.t=e,!r.__c&&(r.__=[gt(void 0,t),function(c){var d=r.__N?r.__N[0]:r.__[0],l=r.t(d,c);d!==l&&(r.__N=[l,r.__[1]],r.__c.setState({}))}],r.__c=S,!S.__f)){var s=function(c,d,l){if(!r.__c.__H)return!0;var _=!1,h=r.__c.props!==c;if(r.__c.__H.__.some(function(p){if(p.__N){_=!0;var m=p.__[0];p.__=p.__N,p.__N=void 0,m!==p.__[0]&&(h=!0)}}),o){var i=o.call(this,c,d,l);return _?i||h:i}return!_||h};S.__f=!0;var o=S.shouldComponentUpdate,a=S.componentWillUpdate;S.componentWillUpdate=function(c,d,l){if(this.__e){var _=o;o=void 0,s(c,d,l),o=_}a&&a.call(this,c,d,l)},S.shouldComponentUpdate=s}return r.__N||r.__}function Q(e,t){var n=He(ne++,3);!x.__s&&yt(n.__H,t)&&(n.__=e,n.u=t,S.__H.__h.push(n))}function Yt(e,t){var n=He(ne++,7);return yt(n.__H,t)&&(n.__=e(),n.__H=t,n.__h=e),n.__}function O(e,t){return fe=8,Yt(function(){return e},t)}function Zt(){for(var e;e=bt.shift();){var t=e.__H;if(e.__P&&t)try{t.__h.some(ce),t.__h.some(Ne),t.__h=[]}catch(n){t.__h=[],x.__e(n,e.__v)}}}x.__b=function(e){S=null,Xe&&Xe(e)},x.__=function(e,t){e&&t.__k&&t.__k.__m&&(e.__m=t.__k.__m),nt&&nt(e,t)},x.__r=function(e){Ye&&Ye(e),ne=0;var t=(S=e.__c).__H;t&&(Oe===S?(t.__h=[],S.__h=[],t.__.some(function(n){n.__N&&(n.__=n.__N),n.u=n.__N=void 0})):(t.__h.some(ce),t.__h.some(Ne),t.__h=[],ne=0)),Oe=S},x.diffed=function(e){Ze&&Ze(e);var t=e.__c;t&&t.__H&&(t.__H.__h.length&&(bt.push(t)!==1&&Qe===x.requestAnimationFrame||((Qe=x.requestAnimationFrame)||en)(Zt)),t.__H.__.some(function(n){n.u&&(n.__H=n.u,n.u=void 0)})),Oe=S=null},x.__c=function(e,t){t.some(function(n){try{n.__h.some(ce),n.__h=n.__h.filter(function(r){return!r.__||Ne(r)})}catch(r){t.some(function(s){s.__h&&(s.__h=[])}),t=[],x.__e(r,n.__v)}}),et&&et(e,t)},x.unmount=function(e){tt&&tt(e);var t,n=e.__c;n&&n.__H&&(n.__H.__.some(function(r){try{ce(r)}catch(s){t=s}}),n.__H=void 0,t&&x.__e(t,n.__v))};var ot=typeof requestAnimationFrame=="function";function en(e){var t,n=function(){clearTimeout(r),ot&&cancelAnimationFrame(t),setTimeout(e)},r=setTimeout(n,35);ot&&(t=requestAnimationFrame(n))}function ce(e){var t=S,n=e.__c;typeof n=="function"&&(e.__c=void 0,n()),S=t}function Ne(e){var t=S;e.__c=e.__(),S=t}function yt(e,t){return!e||e.length!==t.length||t.some(function(n,r){return n!==e[r]})}function gt(e,t){return typeof t=="function"?t(e):t}function J(e,t=8){return typeof e!="string"||e===""?"-":e.length<=t?e:`${e.slice(0,t)}…`}function tn(e,t=16){if(typeof e!="string"||e==="")return"";const n="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",r=[];let s=0,o=0;for(const a of e){const c=n.indexOf(a);if(c===-1)return"";s=s<<6|c,o+=6,o>=8&&(o-=8,r.push(s>>>o&255))}return r.slice(0,Math.ceil(t/2)).map(a=>a.toString(16).padStart(2,"0")).join("").slice(0,t)}function he(e){if(typeof e!="string")return null;const t=e.trim().toLowerCase();return/^[0-9a-f]{64}$/.test(t)?t:null}const W=e=>String(e).padStart(2,"0");function nn(e){if(typeof e!="number"||!Number.isFinite(e))return"-";const t=new Date(e);return`${t.getFullYear()}-${W(t.getMonth()+1)}-${W(t.getDate())} ${W(t.getHours())}:${W(t.getMinutes())}:${W(t.getSeconds())}`}function on(e){if(typeof e!="number"||!Number.isFinite(e))return"-";const t=new Date(e);return`${W(t.getHours())}:${W(t.getMinutes())}:${W(t.getSeconds())}`}function rn(e,t=Date.now()){if(typeof e!="number"||!Number.isFinite(e))return"-";const n=Math.max(0,t-e);return n<1e4?"刚刚":n<6e4?`${Math.floor(n/1e3)} 秒前`:n<36e5?`${Math.floor(n/6e4)} 分钟前`:n<864e5?`${Math.floor(n/36e5)} 小时前`:`${Math.floor(n/864e5)} 天前`}function wt(e,t=Date.now()){return typeof e!="number"||!Number.isFinite(e)?"-":`${nn(e)}（${rn(e,t)}）`}const sn={register:"注册",unregister:"注销",disconnect:"断开"};function an(e){return e==="restricted"?{label:"受限模式",title:"只有名册内的所有者可以接入"}:e==="open"?{label:"开放模式",title:"未启用身份验证，任何人都能接入"}:null}function ln(e){return e==="static"?"静态名册":e==="callback"?"动态回调":typeof e=="string"&&e!==""?e:"-"}function kt(e){const t=typeof e?.code=="string"?e.code:"",n=typeof e?.message=="string"?e.message:"";switch(t){case"admin-not-enabled":return{title:"远端未开启管理面",detail:"目标服务器没有配置 DWEB_ADMIN_TOKEN，管理接口处于关闭状态。请在服务器上设置该环境变量并重启，然后回到本页重试。",retry:!0};case"unauthorized":return{title:"管理凭证无效",detail:"服务器拒绝了当前管理凭证。凭证在连接时已锁定，不能在本页更换——请退出本页，在终端用有效凭证重新运行启动命令：opendweb webui --token <新的管理凭证>（或按原启动命令重启）。",retry:!1};case"no-match":return{title:"目标不在线",detail:"所操作的端点或所有者已不在线或已被移除。在线表已刷新，请核对后再试。",retry:!0};case"timeout":return{title:"连不上服务器",detail:"到不了目标服务器（连接或响应超时）——可能是本地网络问题，或远端已宕机。请检查后重试。",retry:!0};case"network":return{title:"连不上服务器",detail:"到不了目标服务器（网络错误）——可能是本地网络问题，或远端已宕机。请检查后重试。",retry:!0};default:return t.startsWith("http-5")?{title:"服务器内部错误",detail:`远端返回了服务错误（${t||"http-5xx"}）。数据面可能仍在工作；持续出现请登录服务器检查。`,retry:!0}:t==="http-404"?{title:"远端没有这个管理接口",detail:"服务器响应了，但管理面缺少这个接口——它多半运行着旧版本。请把服务器升级到当前版本后重试。",retry:!1}:t.startsWith("http-4")?{title:"请求被拒绝",detail:`远端拒绝了这次请求${n?`（${n}）`:""}。请核对后再试。`,retry:!0}:{title:"请求失败",detail:`${t||"unknown"}${n?`：${n}`:""}——请重试。`,retry:!0}}}function cn(e){if(e==null)return{tone:"ok",label:"管理面连接正常"};const t=typeof e?.code=="string"?e.code:"";return t==="unauthorized"?{tone:"bad",label:"管理凭证无效"}:t==="admin-not-enabled"?{tone:"bad",label:"远端未开启管理面"}:t.startsWith("http-5")?{tone:"bad",label:"服务器内部错误"}:t==="network"||t==="timeout"?{tone:"bad",label:"连不上服务器"}:{tone:"bad",label:"管理面异常"}}function un(e){const t=typeof e?.code=="string"?e.code:"";switch(t){case"bad-pairing":return{title:"配对码不对，或已过期",detail:"请对照终端打印的配对码重新抄录——注意它是 13 位、10 分钟内有效、只能用一次。连续错 5 次配对码会作废，届时需要退出并重新运行命令获取新码。"};case"bad-target":return{title:"服务器地址被拒绝",detail:`${typeof e?.message=="string"?e.message:""} 地址必须是完整的 https:// 或 http:// 开头；明文 http 的公网地址需要启动命令加 --allow-insecure。`};case"bad-origin-host":return{title:"来源校验失败",detail:"请确认浏览器地址栏与终端打印的地址完全一致（不要用别的域名或端口打开本页）。"};case"invalid-request":return{title:"信息不完整",detail:"服务器地址、管理凭证、配对码三项都要填写。"};case"target-frozen":return{title:"目标已锁定",detail:"本进程已连接过服务器，生命周期内不能改指。需要更换目标：退出本页，在终端重新运行命令。"};case"pairing-in-progress":return{title:"正在处理另一个连接请求",detail:"稍等片刻再试。"};default:return{title:"连接失败",detail:`${t}：${e?.message??""}`}}}function ve({error:e,onRetry:t}){if(e==null)return null;const n=kt(e);return u`
    <div class="error-banner" role="alert">
      <div class="banner-title">${n.title}</div>
      <div class="banner-detail">${n.detail}</div>
      ${n.retry&&t?u`<button class="ghost small" onClick=${t}>重试</button>`:null}
    </div>
  `}function dn(){return u`
    <div class="insecure-banner" role="alert">
      <span class="banner-title">连接未加密</span>
      <span class="banner-detail">
        当前目标经明文 http 连接（启动时使用了 --allow-insecure）：管理凭证与管理流量在传输中未加密。建议改用 https 目标，或通过加密隧道访问。生产环境请务必消除此告警。
      </span>
    </div>
  `}function Ct({title:e,confirmLabel:t="确认",cancelLabel:n="先不了",danger:r=!1,onCancel:s,onConfirm:o,children:a}){return u`
    <div class="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>${e}</h3>
        <div class="dialog-body">${a}</div>
        <div class="dialog-actions">
          <button class="ghost" onClick=${s}>${n}</button>
          <button class=${r?"danger":""} onClick=${o}>${t}</button>
        </div>
      </div>
    </div>
  `}function X({value:e,kind:t="值",onCopyText:n}){return u`
    <span class="hex">
      <span class="mono hex-short" title=${e}>${J(e)}</span>
      ${n?u`<button
            class="icon-btn"
            type="button"
            title=${`复制完整${t}`}
            onClick=${()=>n(e)}
          >复制</button>`:null}
    </span>
  `}function ye({lines:e=3,wide:t=!1}){return u`
    <div class="skeleton${t?" wide":""}" aria-hidden="true">
      ${Array.from({length:e},(n,r)=>u`<div key=${r} class="skeleton-line"></div>`)}
    </div>
  `}function _n({error:e,loading:t=!1}){const n=t?{tone:"pending",label:"正在连接服务器…"}:cn(e);return u`
    <span class="health ${n.tone}" role="status" title=${n.label}>
      <span class="dot" aria-hidden="true"></span>${n.label}
    </span>
  `}function St({receipt:e,onCopy:t,onCopyText:n}){const r=e??{},s=typeof r.op=="string"?r.op:"unknown",o=s==="disconnect"?r.endpoint_id:r.fabric_id;return u`
    <div class="receipt-card" data-op=${s}>
      <div class="receipt-head">
        <span class="badge" title=${`op: ${s}`}>${sn[s]??s}</span>
        <span class="receipt-sig-note">已含服务端签名</span>
        ${t?u`<button class="ghost small" type="button" onClick=${()=>t(r)}>复制全文</button>`:null}
      </div>
      <dl class="receipt-fields">
        <dt>时间</dt>
        <dd>${wt(r.ts)}</dd>
        <dt>名册版本</dt>
        <dd class="mono">v${r.generation??"-"}</dd>
        <dt>目标</dt>
        <dd><${X} value=${o} kind=${s==="disconnect"?"端点":"Fabric"} onCopyText=${n}/></dd>
        <dt>审计签名</dt>
        <dd class="mono muted">${tn(r.receipt_sig)||"-"}…</dd>
        ${typeof r.kicked_connections=="number"?u`<dt>一并断开的连接</dt><dd class="mono">${r.kicked_connections} 条</dd>`:null}
      </dl>
    </div>
  `}function ue({title:e,children:t,action:n=null}){return u`
    <div class="empty-state">
      <div class="empty-title">${e}</div>
      <div class="empty-body">${t}</div>
      ${n}
    </div>
  `}function pn({state:e,form:t,busy:n,result:r,onInput:s,onSubmit:o,onGoOverview:a}){if(r!==null&&r.ok===!0)return u`
      <div class="setup-world">
        <div class="setup-card success">
          <div class="setup-kicker">配对完成</div>
          <h1>已连接。正在进入总览…</h1>
          <p class="hint">
            目标已锁定：<span class="mono">${e?.server_host_masked??"-"}</span>
            ——本进程运行期间不能改指其他服务器。
          </p>
          <button onClick=${a}>立即进入总览</button>
        </div>
      </div>
    `;const c=r!==null&&r.ok===!1?un(r.error):null;return u`
    <div class="setup-world">
      <div class="setup-card">
        <div class="setup-kicker">opendweb 服务器控制台 · 首次设置</div>
        <h1>把控制台接上你的服务器</h1>
        <p class="setup-lede">
          这个页面运行在你自己的电脑上，与云端的 dweb-server
          之间隔着一条安全通道——管理凭证只交给本地进程，浏览器不保存、不回显。
        </p>
        <div class="setup-steps">
          <h2>从终端抄三样东西</h2>
          <ol>
            <li><strong>服务器地址</strong>——形如 <span class="mono">https://srv.example.com:18787</span></li>
            <li><strong>管理凭证</strong>——服务器启动时设置的 <span class="mono">DWEB_ADMIN_TOKEN</span></li>
            <li><strong>配对码</strong>——终端最新打印的一行 13 位码，10 分钟内有效、只能用一次</li>
          </ol>
        </div>
        ${c!==null?u`
              <div class="error-banner" role="alert">
                <div class="banner-title">${c.title}</div>
                <div class="banner-detail">${c.detail}</div>
              </div>
            `:null}
        <form
          class="stack"
          onSubmit=${d=>{d.preventDefault(),o()}}
        >
          <label>
            ① 服务器地址
            <input
              name="server"
              value=${t.server}
              onInput=${d=>s("server",d.currentTarget.value)}
              autocomplete="off"
              spellcheck="false"
              placeholder="https://srv.example.com:18787"
            />
          </label>
          <label>
            ② 管理凭证
            <input
              name="token"
              type="password"
              value=${t.token}
              onInput=${d=>s("token",d.currentTarget.value)}
              autocomplete="off"
              placeholder="粘贴后立即交给本地进程，本页不留存"
            />
          </label>
          <label>
            ③ 配对码
            <input
              name="code"
              value=${t.code}
              onInput=${d=>s("code",d.currentTarget.value)}
              autocomplete="off"
              spellcheck="false"
              placeholder="13 位大写字母或数字"
            />
          </label>
          <button
            type="submit"
            disabled=${n||t.server===""||t.token===""||t.code===""}
          >
            ${n?"正在连接…":"连接并锁定"}
          </button>
          <p class="hint">
            连接成功后目标即锁定——本进程运行期间不能改指其他服务器；需要更换时，退出并在终端重新运行命令。
          </p>
        </form>
      </div>
    </div>
  `}function fn({masked:e,open:t=!1,onToggle:n}){return u`
    <button
      class="target-chip${t?" open":""}"
      type="button"
      onClick=${n}
      aria-expanded=${t}
      title="连接详情"
    >
      <span class="mono">${e??"-"}</span><span class="caret" aria-hidden="true">▾</span>
    </button>
  `}function hn({state:e,onClose:t}){return u`
    <div class="conn-panel" role="dialog" aria-label="连接详情">
      <h3>连接详情</h3>
      <dl class="receipt-fields">
        <dt>目标</dt>
        <dd class="mono">${e?.server_host_masked??"-"}</dd>
        <dt>安全模型</dt>
        <dd>管理凭证只保存在本地 sidecar 进程内，浏览器不保存、不回显。</dd>
        <dt>更换目标</dt>
        <dd>目标在本进程生命周期内已锁定。需要连接其他服务器时，退出本页并在终端重新运行启动命令。</dd>
      </dl>
      ${e?.insecure===!0?u`
            <div class="conn-panel-warn">
              连接未加密：当前目标经明文 http 传输，管理凭证与管理流量未加密。
            </div>
          `:null}
      <button class="ghost small" type="button" onClick=${t}>关闭</button>
    </div>
  `}function vn({state:e,data:t,error:n,ownersData:r,lastFailAt:s,onRetry:o,onGoOnline:a,onGoRegister:c}){const d=Array.isArray(t?.active_connections)?t.active_connections:[],l=Array.isArray(r?.owners)?r.owners:[],_=Array.isArray(r?.owners),h=d.reduce((k,b)=>k+(Number(b?.connections)||0),0),i=an(t?.mode),p=n!=null,m=p&&kt(n).retry;return u`
    <section class="view overview" data-view="overview">
      <div class="view-head">
        <h2>总览</h2>
        <p class="hint">这台服务器正常吗、谁在用、谁能用——打开即答。</p>
      </div>
      ${p?u`
            <${ve} error=${n} onRetry=${o}/>
            ${m?u`
                  <p class="hint auto-retry">
                    自动每 5 秒重试中${s!=null?`（上次失败 ${on(s)}）`:""}。
                  </p>
                `:null}
          `:t===null?u`<div class="conclusion pending"><span class="dot" aria-hidden="true"></span>正在连接服务器…</div>`:u`
              <div class="conclusion ok">
                <span class="dot" aria-hidden="true"></span>
                一切正常。${h} 条在线连接${_?`，${l.length} 个所有者`:""}。
              </div>
            `}
      ${t===null&&!p?u`<${ye} lines=${4}/>`:t!==null?u`
              <div class="stats">
                <button class="stat link" type="button" onClick=${a} title="查看在线连接明细">
                  <span class="stat-label">在线连接</span>
                  <span class="stat-value mono">${h} 条</span>
                  <span class="stat-sub">按端点 ${d.length} 个</span>
                </button>
                <button class="stat link" type="button" onClick=${c} title="管理所有者名册">
                  <span class="stat-label">所有者</span>
                  <span class="stat-value mono">${_?`${l.length} 个`:"…"}</span>
                  <span class="stat-sub">名册内可接入的 Fabric</span>
                </button>
                <div class="stat">
                  <span class="stat-label">接入模式</span>
                  <span class="stat-value">
                    ${i!==null?u`<span class="badge mode" title=${i.title}>${i.label}</span>`:u`<span class="muted">-</span>`}
                  </span>
                </div>
                <div class="stat" title="每次所有者名册变更后加 1，用于确认变更已生效">
                  <span class="stat-label">名册版本</span>
                  <span class="stat-value mono">v${t.generation??"-"}</span>
                </div>
              </div>
              ${t?.mode==="open"?u`
                    <div class="open-note">
                      这台服务器未启用身份验证，任何人都能接入。
                    </div>
                  `:null}
              ${t?.mode==="restricted"&&_&&l.length===0?u`
                    <div class="empty-state guide">
                      <div class="empty-title">还没有任何所有者能使用这台服务器。</div>
                      <div class="empty-body">
                        受限模式下，名册为空意味着除了你没有人能接入。如果有 Fabric
                        需要接入，去注册第一个所有者。
                      </div>
                      <button type="button" onClick=${c}>去注册所有者</button>
                    </div>
                  `:null}
              <div class="config-card">
                <h3>配置</h3>
                <dl class="config">
                  <dt>准入策略</dt>
                  <dd>${ln(t?.policy)}</dd>
                  <dt>每所有者连接上限</dt>
                  <dd class="mono">${t?.max_connections_per_owner??"未设置"}</dd>
                  <dt>中继（relay）</dt>
                  <dd>${t?.relay_enabled===!0?"已启用":t?.relay_enabled===!1?"未启用":"-"}</dd>
                </dl>
              </div>
            `:null}
    </section>
  `}const $n={dispatched:"已下发",converging:"收敛中",converged:"已收敛",unconfirmed:"超时未确认"};function mn(e){const{state:t,data:n,error:r,form:s,formError:o,busy:a,receipt:c,confirm:d}=e,l=e.onlineFabrics instanceof Set?e.onlineFabrics:new Set,{onInput:_,onRegister:h,onFocusRegister:i,onAskUnregister:p,onConfirmUnregister:m,onCancelConfirm:k,onCopy:b,onCopyText:y,onFilterOnline:$,onRetry:T}=e,N=Array.isArray(n?.owners)?n.owners:[],F=he(s.fabricId)!==null||s.fabricId==="",D=he(s.root)!==null||s.root==="";return u`
    <section class="panel roster" data-section="roster">
      ${r!=null?u`<${ve} error=${r} onRetry=${T}/>`:null}
      <div class="panel-grid">
        <div class="table-card">
          <div class="table-card-head">
            <h3>
              所有者名册
              <span class="sub" title="每次所有者名册变更后加 1，用于确认变更已生效">
                名册版本 v${n?.generation??"-"}
              </span>
            </h3>
          </div>
          ${n===null?r!=null?null:u`<${ye} lines=${3}/>`:N.length===0?u`
                  <${ue}
                    title="名册是空的。"
                    action=${u`<button type="button" onClick=${i}>注册所有者</button>`}
                  >
                    注册后，对应的 Fabric 才能通过这台服务器组网。
                  <//>
                `:u`
                  <table>
                    <thead>
                      <tr><th>Fabric</th><th>根端点</th><th>注册时间</th><th></th></tr>
                    </thead>
                    <tbody>
                      ${N.map(v=>u`
                          <tr key=${v.fabric_id+v.root}>
                            <td><${X} value=${v.fabric_id} kind="Fabric" onCopyText=${y}/></td>
                            <td><${X} value=${v.root} kind="根端点" onCopyText=${y}/></td>
                            <td class="time">${wt(v.registered_at)}</td>
                            <td class="actions">
                              <button
                                class="ghost small online-badge${l.has(v.fabric_id)?" in-use":""}"
                                type="button"
                                title=${l.has(v.fabric_id)?"该所有者有活跃连接——点击查看在线连接明细":"该所有者当前没有活跃连接——点击查看在线视角"}
                                onClick=${()=>$(v.fabric_id)}
                              >${l.has(v.fabric_id)?"在用":"未在用"}</button>
                              <button
                                class="danger ghost small"
                                type="button"
                                onClick=${()=>p(v)}
                              >注销</button>
                            </td>
                          </tr>
                        `)}
                    </tbody>
                  </table>
                `}
        </div>
        <div class="side-card">
          <h3>注册所有者</h3>
          <p class="hint">所有者 = 允许接入这台服务器的一个 Fabric 网络。</p>
          <form
            class="stack"
            onSubmit=${v=>{v.preventDefault(),h()}}
          >
            <label>
              Fabric
              <input
                id="owner-fabric-input"
                name="fabricId"
                class=${F?"":"invalid"}
                value=${s.fabricId}
                onInput=${v=>_("fabricId",v.currentTarget.value)}
                autocomplete="off"
                spellcheck="false"
                placeholder="64 位十六进制字符（0-9 / a-f）"
              />
            </label>
            <label>
              根端点
              <input
                name="root"
                class=${D?"":"invalid"}
                value=${s.root}
                onInput=${v=>_("root",v.currentTarget.value)}
                autocomplete="off"
                spellcheck="false"
                placeholder="64 位十六进制字符（0-9 / a-f）"
              />
            </label>
            ${o!==null?u`<p class="field-error" role="alert">${o}</p>`:null}
            <button
              type="submit"
              disabled=${a||s.fabricId===""||s.root===""||!F||!D}
            >${a?"提交中…":"注册"}</button>
          </form>
        </div>
      </div>
      ${c!==null?u`
            <div class="receipt-area">
              <h3>变更回执</h3>
              <${St} receipt=${c} onCopy=${b} onCopyText=${y}/>
            </div>
          `:null}
      ${d!==null?u`
            <${Ct}
              title="注销这个所有者？"
              confirmLabel="确认注销"
              danger=${!0}
              onCancel=${k}
              onConfirm=${m}
            >
              <p>将从名册移除以下所有者：</p>
              <p>
                Fabric <span class="mono" title=${d.fabricId}>${J(d.fabricId)}</span>
                · 根端点 <span class="mono" title=${d.root}>${J(d.root)}</span>
              </p>
              <p>
                移除后，该 Fabric 的新连接立即被拒；名下如仍有在线连接，将一并断开（异步收敛）。
                如需恢复，重新注册即可。
              </p>
            <//>
          `:null}
    </section>
  `}function bn(e){const{state:t,data:n,error:r,confirm:s,disconnect:o,filter:a}=e,{onAskDisconnect:c,onConfirmDisconnect:d,onCancelConfirm:l,onCopy:_,onCopyText:h,onRetry:i,onClearFilter:p,onDismissDisconnect:m}=e,k=Array.isArray(n?.per_endpoint)?n.per_endpoint:[],b=Array.isArray(n?.per_owner)?n.per_owner:[],y=a!==null?k.filter(v=>v.fabric_id===a):k,$=a!==null?b.filter(v=>v.fabric_id===a):b,T=n?.quota??{},N=T.configured===!0?T.max_connections_per_owner??"-":"未设置",F=o?.kind==="fabric"?"所有者":"端点",D=s?.kind==="fabric"?"所有者":"端点";return u`
    <section class="panel online" data-section="online">
      ${r!=null?u`<${ve} error=${r} onRetry=${i}/>`:null}
      ${a!==null?u`
            <div class="filter-chip">
              只看所有者 <span class="mono" title=${a}>${J(a)}</span>
              <button class="icon-btn" type="button" onClick=${p} title="清除过滤">清除</button>
            </div>
          `:null}
      ${o!==null?u`
            <div class="disconnect-panel" data-phase=${o.phase}>
              <div class="dp-head">
                <span class="badge phase-${o.phase}">
                  ${$n[o.phase]??o.phase}
                </span>
                <span class="mono" title=${o.id}>${J(o.id)}</span>
                <span class="hint">（按${F}断开）</span>
                ${(o.phase==="converged"||o.phase==="unconfirmed")&&m?u`<button class="ghost small" type="button" onClick=${m}>关闭</button>`:null}
              </div>
              ${o.error!==null&&o.error!==void 0?o.error?.code==="no-match"?u`
                      <p class="dp-note">
                        这个${F}已经不在线了——可能刚好自行断开。在线表已刷新，请核对。
                      </p>
                    `:u`<${ve} error=${o.error}/>`:o.phase==="dispatched"?u`<p class="dp-note">断开指令正在下发…</p>`:o.phase==="converging"?u`<p class="dp-note">正在确认连接已断开，通常几秒内完成……</p>`:o.phase==="converged"?u`<p class="dp-note">该${F}已从在线表消失。回执如下，可复制存档。</p>`:o.phase==="unconfirmed"?u`
                            <p class="dp-note">
                              指令已下发，但 15 秒内在线表未观察到收敛。断开是尽力而为的——请刷新在线表核对；若连接仍在，可再次断开。
                            </p>
                          `:null}
              ${Array.isArray(o.receipts)&&o.receipts.length>0?u`
                    <div class="receipt-area">
                      ${o.receipts.map((v,U)=>u`<${St} key=${U} receipt=${v} onCopy=${_} onCopyText=${h}/>`)}
                    </div>
                  `:null}
            </div>
          `:null}
      ${n===null?r!=null?null:u`<${ye} lines=${4}/>`:n.mode==="open"?u`
              <${ue} title="开放模式下没有在线统计。">
                这台服务器未启用身份验证，管理面只能看到配置，看不到连接明细。
              <//>
            `:n.relay_enabled===!1?u`
                <${ue} title="中继（relay）未启用。">
                  这台服务器没有开启中继服务，因此没有在线连接可显示。
                <//>
              `:u`
                <div class="table-card">
                  <div class="table-card-head"><h3>按端点</h3></div>
                  ${k.length===0?u`
                        <${ue} title="当前没有在线连接。">
                          已注册的所有者建立组网后，连接会实时出现在这里。
                        <//>
                      `:y.length===0?u`<p class="hint filtered-empty">该所有者当前没有在线连接。</p>`:u`
                          <table>
                            <thead>
                              <tr><th>端点</th><th>Fabric</th><th class="num">连接数</th><th></th></tr>
                            </thead>
                            <tbody>
                              ${y.map(v=>u`
                                  <tr key=${v.endpoint_id+v.fabric_id}>
                                    <td><${X} value=${v.endpoint_id} kind="端点" onCopyText=${h}/></td>
                                    <td><${X} value=${v.fabric_id} kind="Fabric" onCopyText=${h}/></td>
                                    <td class="mono num">${v.connections}</td>
                                    <td class="actions">
                                      <button
                                        class="danger ghost small"
                                        type="button"
                                        onClick=${()=>c("endpoint",v.endpoint_id,v.connections)}
                                      >断开</button>
                                    </td>
                                  </tr>
                                `)}
                            </tbody>
                          </table>
                        `}
                </div>
                <div class="table-card">
                  <div class="table-card-head"><h3>按所有者</h3></div>
                  ${b.length===0?u`<p class="hint filtered-empty">没有所有者正在使用。</p>`:$.length===0?u`<p class="hint filtered-empty">该所有者当前没有在线连接。</p>`:u`
                          <table>
                            <thead>
                              <tr><th>Fabric</th><th class="num">在用 / 上限</th><th></th></tr>
                            </thead>
                            <tbody>
                              ${$.map(v=>u`
                                  <tr key=${v.fabric_id}>
                                    <td><${X} value=${v.fabric_id} kind="Fabric" onCopyText=${h}/></td>
                                    <td class="mono num">${v.connections} / ${N}</td>
                                    <td class="actions">
                                      <button
                                        class="danger ghost small"
                                        type="button"
                                        onClick=${()=>c("fabric",v.fabric_id,v.connections)}
                                      >全部断开</button>
                                    </td>
                                  </tr>
                                `)}
                            </tbody>
                          </table>
                        `}
                </div>
              `}
      ${s!==null?u`
            <${Ct}
              title="断开这个${D}？"
              confirmLabel="确认断开"
              danger=${!0}
              onCancel=${l}
              onConfirm=${d}
            >
              ${s.kind==="endpoint"?u`
                    <p>
                      将向服务器下发断开指令，端点
                      <span class="mono" title=${s.id}>${J(s.id)}</span>
                      的 <strong>${s.count} 条连接</strong>会被关闭。
                    </p>
                  `:u`
                    <p>
                      将向服务器下发断开指令，所有者
                      <span class="mono" title=${s.id}>${J(s.id)}</span>
                      名下的 <strong>${s.count} 条连接</strong>会被关闭。
                    </p>
                  `}
              <p>断开是异步的：确认后这里会显示进度，直到连接从在线表消失。</p>
            <//>
          `:null}
    </section>
  `}function yn(e){const{section:t,onSection:n}=e,r={state:e.state,data:e.data,error:e.error,onlineFabrics:e.onlineFabrics,form:e.form,formError:e.formError,busy:e.busy,receipt:e.receipt,confirm:e.confirm,onInput:e.onInput,onRegister:e.onRegister,onFocusRegister:e.onFocusRegister,onAskUnregister:e.onAskUnregister,onConfirmUnregister:e.onConfirmUnregister,onCancelConfirm:e.onCancelOwnerConfirm,onCopy:e.onCopy,onCopyText:e.onCopyText,onFilterOnline:e.onFilterOnline,onRetry:e.onRetry},s={state:e.state,data:e.connData,error:e.connError,confirm:e.connConfirm,disconnect:e.disconnect,filter:e.filter,onAskDisconnect:e.onAskDisconnect,onConfirmDisconnect:e.onConfirmDisconnect,onCancelConfirm:e.onCancelConnConfirm,onCopy:e.onCopy,onCopyText:e.onCopyText,onRetry:e.onRetryConnections,onClearFilter:e.onClearFilter,onDismissDisconnect:e.onDismissDisconnect};return u`
    <section class="view access" data-view="access">
      <div class="view-head">
        <h2>访问管理</h2>
        <p class="hint">谁能用这台服务器（名册）、谁正在用（在线）——同一对象的两个视角。</p>
      </div>
      <div class="segmented" role="tablist" aria-label="访问管理视角">
        <button
          role="tab"
          type="button"
          aria-selected=${t==="roster"}
          class=${t==="roster"?"active":""}
          onClick=${()=>n("roster")}
        >所有者名册</button>
        <button
          role="tab"
          type="button"
          aria-selected=${t==="online"}
          class=${t==="online"?"active":""}
          onClick=${()=>n("online")}
        >在线连接</button>
      </div>
      ${t==="roster"?u`<${mn} ...${r}/>`:u`<${bn} ...${s}/>`}
    </section>
  `}class Y extends Error{constructor(t,n,r=null){super(n),this.name="AdminError",this.code=t,this.status=r}static async fromResponse(t){let n=null,r=null;try{const s=JSON.parse(await t.text()),o=s&&typeof s=="object"?s.error:null;o&&typeof o=="object"&&typeof o.code=="string"&&typeof o.message=="string"&&(n=o.code,r=o.message)}catch{}return n===null&&(n=`http-${t.status}`),r===null&&(r=t.statusText&&t.statusText!==""?`HTTP ${t.status} ${t.statusText}`:`HTTP ${t.status}`),new Y(n,r,t.status)}}let gn=wn;function wn(e,t={}){return fetch(e,{...t,signal:t.signal??AbortSignal.timeout(15e3)})}function kn(e){const t=e&&typeof e=="object"?e.name:null;if(t==="TimeoutError"||t==="AbortError")return new Y("timeout","request timed out",null);const n=e instanceof Error?e.message:String(e??"unknown error");return new Y("network",`request failed: ${n}`,null)}async function M(e,t){let n;try{n=await gn(e,t)}catch(s){throw kn(s)}if(!n.ok)throw await Y.fromResponse(n);const r=await n.text();try{return JSON.parse(r)}catch{throw new Y("invalid-response",`response body is not JSON (status ${n.status})`,n.status)}}function Cn(){return M("/sidecar/state")}function Sn(e){return M("/sidecar/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(e)})}function xn(){return M("/api/status")}function Tn(){return M("/api/owners")}function rt(){return M("/api/connections")}function En(e,t){return M("/api/owners",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({fabric_id_hex:e,root_hex:t})})}function Fn(e,t){return M(`/api/owners/${e}/${t}`,{method:"DELETE"})}function On(e){return M("/api/connections/disconnect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({endpoint_id:e})})}function An(e){return M("/api/connections/disconnect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({fabric_id:e})})}const st=5e3,Dn=1e3,Nn=15,Pn=900;function In(e,t){if(t!=="ready")return{view:"setup"};const n=String(e??"").replace(/^#\/?/,""),[r,s]=n.split("/");switch(r){case"":case"status":return{view:"overview"};case"connect":return{view:"overview",panel:!0};case"owners":case"access":return{view:"access",section:s==="online"?"online":"roster"};case"connections":return{view:"access",section:"online"};default:return{view:"overview"}}}const se=()=>document.visibilityState==="visible",Ln=e=>new Promise(t=>setTimeout(t,e));function Rn(e,t,n){return(Array.isArray(e?.per_endpoint)?e.per_endpoint:[]).some(s=>t==="endpoint"?s.endpoint_id===n:s.fabric_id===n)}function Hn(){const[e,t]=C(()=>location.hash),[n,r]=C(null),[s,o]=C(null),[a,c]=C({server:"",token:"",code:""}),[d,l]=C(!1),[_,h]=C(null),[i,p]=C(null),[m,k]=C(null),[b,y]=C(null),[$,T]=C(null),N=new Set(Array.isArray($?.per_owner)?$.per_owner.map(f=>f.fabric_id):[]),[F,D]=C(null),[v,U]=C(null),[G,A]=C(null),[I,Me]=C({fabricId:"",root:""}),[xt,Ue]=C(null),[Tt,oe]=C(!1),[Et,Be]=C(null),[ge,we]=C(null),[ke,Ce]=C(null),[Ft,Z]=C(null),[We,Se]=C(!1),[Ot,xe]=C(null),R=n!==null&&n.phase==="ready"?"ready":"setup",L=In(e,R);Q(()=>{const f=()=>t(location.hash);return window.addEventListener("hashchange",f),()=>window.removeEventListener("hashchange",f)},[]);const ee=O(async()=>{try{r(await Cn()),o(null)}catch(f){o(f)}},[]);Q(()=>{ee()},[ee]),Q(()=>{L.panel===!0&&R==="ready"&&Se(!0)},[L.panel,R]);const j=O(async()=>{try{p(await xn()),k(null)}catch(f){k(f),y(Date.now())}},[]);Q(()=>{if(R!=="ready")return;let f=!1;const g=()=>{f||!se()||j()};g();const E=setInterval(g,st),P=()=>{se()&&g()};return document.addEventListener("visibilitychange",P),()=>{f=!0,clearInterval(E),document.removeEventListener("visibilitychange",P)}},[R,j]);const q=O(async()=>{try{T(await rt()),D(null)}catch(f){D(f)}},[]);Q(()=>{if(R!=="ready")return;let f=!1;const g=()=>{f||!se()||q()};g();const E=setInterval(g,st),P=()=>{se()&&g()};return document.addEventListener("visibilitychange",P),()=>{f=!0,clearInterval(E),document.removeEventListener("visibilitychange",P)}},[R,q]);const V=O(async()=>{try{U(await Tn()),A(null)}catch(f){A(f)}},[]);Q(()=>{R==="ready"&&(L.view==="overview"||L.view==="access"&&L.section==="roster")&&V()},[R,L.view,L.section,V]);const At=O((f,g)=>{c(E=>({...E,[f]:g}))},[]),Dt=O(async()=>{l(!0),h(null);try{await Sn({pairing_code:a.code.trim(),server:a.server.trim(),token:a.token}),c(f=>({...f,token:"",code:""})),h({ok:!0}),await ee(),setTimeout(()=>{location.hash="#/",h(null)},Pn)}catch(f){c(g=>({...g,token:""})),h({ok:!1,error:f})}finally{l(!1)}},[a,ee]),Nt=O(()=>{location.hash="#/",h(null)},[]),Pt=O((f,g)=>{Me(E=>({...E,[f]:g}))},[]),It=O(async()=>{const f=he(I.fabricId),g=he(I.root);if(f===null||g===null){Ue("Fabric 与根端点均需为 64 位十六进制字符（0-9 / a-f）。通常从成员的密钥管理处复制，不要手抄。");return}Ue(null),oe(!0);try{Be(await En(f,g)),Me({fabricId:"",root:""}),await Promise.all([V(),j()])}catch(E){A(E)}finally{oe(!1)}},[I,V,j]),Lt=O(async()=>{const{fabricId:f,root:g}=ge??{};if(we(null),f!==void 0){oe(!0);try{Be(await Fn(f,g)),await Promise.all([V(),j(),q()])}catch(E){A(E)}finally{oe(!1)}}},[ge,V,j,q]),Rt=O(async()=>{const{kind:f,id:g}=ke??{};if(Ce(null),g!==void 0){Z({kind:f,id:g,phase:"dispatched",receipts:[],error:null});try{const E=f==="endpoint"?await On(g):await An(g);Z({kind:f,id:g,phase:"converging",receipts:E?.receipts??[],error:null});let P=!1;for(let K=0;K<Nn;K++){await Ln(Dn);let Ee;try{Ee=await rt(),T(Ee),D(null)}catch{continue}if(!Rn(Ee,f,g)){P=!0;break}}const Wt=P?"converged":"unconfirmed";Z(K=>K===null?K:{...K,phase:Wt})}catch(E){E?.code==="no-match"&&q(),Z(P=>P===null?P:{...P,error:E})}}},[ke,q]),Te=O(async f=>{try{await navigator.clipboard.writeText(f)}catch{}},[]),Ht=O(f=>Te(JSON.stringify(f,null,2)),[Te]),je=O((f=null)=>{xe(f),location.hash="#/access/online"},[]),Mt=O(f=>{f!=="online"&&xe(null),location.hash=f==="online"?"#/access/online":"#/access/roster"},[]),qe=O(()=>{location.hash="#/access/roster",setTimeout(()=>document.getElementById("owner-fabric-input")?.focus(),60)},[]);if(n===null&&s!==null)return u`
      <div class="boot-screen">
        <div class="boot-card">
          <h1>控制台后台没有响应</h1>
          <p>
            本地 sidecar 进程可能已退出。请回到终端查看输出，或重新运行启动命令打开新页面。
          </p>
          <button onClick=${ee}>重试</button>
        </div>
      </div>
    `;if(n===null)return u`
      <div class="boot-screen">
        <div class="boot-card">
          <h1>正在连接服务器…</h1>
          <${ye} lines=${3}/>
        </div>
      </div>
    `;if(R==="setup"||_?.ok===!0)return u`
      <${pn}
        state=${n}
        form=${a}
        busy=${d}
        result=${_}
        onInput=${At}
        onSubmit=${Dt}
        onGoOverview=${Nt}
      />
    `;const Ut=i===null?null:{...i,relay_enabled:$?.relay_enabled},Bt=m??F;return u`
    <div class="shell" data-phase="ready">
      <header class="topbar">
        <span class="brand">opendweb<span class="brand-sub">服务器控制台</span></span>
        <${_n}
          error=${m}
          loading=${i===null&&m===null}
        />
        <span class="topbar-spacer"></span>
        <${fn}
          masked=${n.server_host_masked}
          open=${We}
          onToggle=${()=>Se(f=>!f)}
        />
        ${We?u`<${hn} state=${n} onClose=${()=>Se(!1)}/>`:null}
      </header>
      ${n.insecure===!0?u`<${dn}/>`:null}
      <div class="layout">
        <aside class="sidenav">
          <a class=${L.view==="overview"?"active":""} href="#/">总览</a>
          <a class=${L.view==="access"?"active":""} href="#/access">访问管理</a>
        </aside>
        <main class="content">
          ${L.view==="overview"?u`
                <${vn}
                  state=${n}
                  data=${Ut}
                  error=${Bt}
                  ownersData=${v}
                  ownersError=${G}
                  lastFailAt=${b}
                  onRetry=${j}
                  onGoOnline=${()=>je(null)}
                  onGoRegister=${qe}
                />
              `:u`
                <${yn}
                  state=${n}
                  section=${L.section}
                  onlineFabrics=${N}
                  data=${v}
                  error=${G}
                  form=${I}
                  formError=${xt}
                  busy=${Tt}
                  receipt=${Et}
                  confirm=${ge}
                  onInput=${Pt}
                  onRegister=${It}
                  onFocusRegister=${qe}
                  onAskUnregister=${we}
                  onConfirmUnregister=${Lt}
                  onCancelOwnerConfirm=${()=>we(null)}
                  onCopy=${Ht}
                  onCopyText=${Te}
                  onFilterOnline=${je}
                  onRetry=${V}
                  onSection=${Mt}
                  connData=${$}
                  connError=${F}
                  connConfirm=${ke}
                  disconnect=${Ft}
                  filter=${Ot}
                  onAskDisconnect=${(f,g,E)=>Ce({kind:f,id:g,count:E})}
                  onConfirmDisconnect=${Rt}
                  onCancelConnConfirm=${()=>Ce(null)}
                  onRetryConnections=${q}
                  onClearFilter=${()=>xe(null)}
                  onDismissDisconnect=${()=>Z(null)}
                />
              `}
        </main>
      </div>
    </div>
  `}Kt(u`<${Hn}/>`,document.getElementById("app"));
