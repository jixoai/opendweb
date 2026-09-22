(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))o(s);new MutationObserver(s=>{for(const r of s)if(r.type==="childList")for(const a of r.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&o(a)}).observe(document,{childList:!0,subtree:!0});function n(s){const r={};return s.integrity&&(r.integrity=s.integrity),s.referrerPolicy&&(r.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?r.credentials="include":s.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function o(s){if(s.ep)return;s.ep=!0;const r=n(s);fetch(s.href,r)}})();var de,g,Xe,M,He,Ye,Ze,ke,re,Q,et,xe,Se,Ee,ae={},ce=[],St=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,pe=Array.isArray;function R(t,e){for(var n in e)t[n]=e[n];return t}function Te(t){t&&t.parentNode&&t.parentNode.removeChild(t)}function tt(t,e,n){var o,s,r,a={};for(r in e)r=="key"?o=e[r]:r=="ref"?s=e[r]:a[r]=e[r];if(arguments.length>2&&(a.children=arguments.length>3?de.call(arguments,2):n),typeof t=="function"&&t.defaultProps!=null)for(r in t.defaultProps)a[r]===void 0&&(a[r]=t.defaultProps[r]);return oe(t,a,o,s,null)}function oe(t,e,n,o,s){var r={type:t,props:e,key:n,ref:o,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:s??++Xe,__i:-1,__u:0};return s==null&&g.vnode!=null&&g.vnode(r),r}function fe(t){return t.children}function se(t,e){this.props=t,this.context=e}function q(t,e){if(e==null)return t.__?q(t.__,t.__i+1):null;for(var n;e<t.__k.length;e++)if((n=t.__k[e])!=null&&n.__e!=null)return n.__e;return typeof t.type=="function"?q(t):null}function Et(t){if(t.__P&&t.__d){var e=t.__v,n=e.__e,o=[],s=[],r=R({},e);r.__v=e.__v+1,g.vnode&&g.vnode(r),Ae(t.__P,r,e,t.__n,t.__P.namespaceURI,32&e.__u?[n]:null,o,n??q(e),!!(32&e.__u),s),r.__v=e.__v,r.__.__k[r.__i]=r,it(o,r,s),e.__e=e.__=null,r.__e!=n&&nt(r)}}function nt(t){if((t=t.__)!=null&&t.__c!=null)return t.__e=t.__c.base=null,t.__k.some(function(e){if(e!=null&&e.__e!=null)return t.__e=t.__c.base=e.__e}),nt(t)}function Re(t){(!t.__d&&(t.__d=!0)&&M.push(t)&&!le.__r++||He!=g.debounceRendering)&&((He=g.debounceRendering)||Ye)(le)}function le(){try{for(var t,e=1;M.length;)M.length>e&&M.sort(Ze),t=M.shift(),e=M.length,Et(t)}finally{M.length=le.__r=0}}function rt(t,e,n,o,s,r,a,l,_,c,d){var v,i,u,$,h,w,k=o&&o.__k||ce,m=e.length;for(_=Ot(n,e,k,_,m),v=0;v<m;v++)(u=n.__k[v])!=null&&(i=u.__i!=-1&&k[u.__i]||ae,u.__i=v,w=Ae(t,u,i,s,r,a,l,_,c,d),$=u.__e,u.ref&&i.ref!=u.ref&&(i.ref&&Ne(i.ref,null,u),d.push(u.ref,u.__c||$,u)),h==null&&$!=null&&(h=$),4&u.__u?(_=ot(u,_,t),i.__e&&(i.__e=null)):typeof u.type=="function"&&w!==void 0?_=w:$&&(_=$.nextSibling),u.__u&=-7);return n.__e=h,_}function Ot(t,e,n,o,s){var r,a,l,_,c,d=n.length,v=d,i=0;for(t.__k=new Array(s),r=0;r<s;r++)(a=e[r])!=null&&typeof a!="boolean"&&typeof a!="function"?(typeof a=="string"||typeof a=="number"||typeof a=="bigint"||a.constructor==String?a=t.__k[r]=oe(null,a,null,null,null):pe(a)?a=t.__k[r]=oe(fe,{children:a},null,null,null):a.constructor===void 0&&a.__b>0?a=t.__k[r]=oe(a.type,a.props,a.key,a.ref?a.ref:null,a.__v):t.__k[r]=a,_=r+i,a.__=t,a.__b=t.__b+1,l=null,(c=a.__i=xt(a,n,_,v))!=-1&&(v--,(l=n[c])&&(l.__u|=2)),l==null||l.__v==null?(c==-1&&(s>d?i--:s<d&&i++),typeof a.type!="function"&&(a.__u|=4)):c!=_&&(c==_-1?i--:c==_+1?i++:(c>_?i--:i++,a.__u|=4))):t.__k[r]=null;if(v)for(r=0;r<d;r++)(l=n[r])!=null&&(2&l.__u)==0&&(l.__e==o&&(o=q(l)),ct(l,l));return o}function ot(t,e,n){var o,s;if(typeof t.type=="function"){for(o=t.__k,s=0;o&&s<o.length;s++)o[s]&&(o[s].__=t,e=ot(o[s],e,n));return e}t.__e!=e&&(e&&t.type&&!e.parentNode&&(e=q(t)),e=n.insertBefore(t.__e,e||null));do e=e&&e.nextSibling;while(e!=null&&e.nodeType==8);return e}function xt(t,e,n,o){var s,r,a,l=t.key,_=t.type,c=e[n],d=c!=null&&(2&c.__u)==0;if(c===null&&l==null||d&&l==c.key&&_==c.type)return n;if(o>(d?1:0)){for(s=n-1,r=n+1;s>=0||r<e.length;)if((c=e[a=s>=0?s--:r++])!=null&&(2&c.__u)==0&&l==c.key&&_==c.type)return a}return-1}function Ue(t,e,n){e[0]=="-"?t.setProperty(e,n??""):t[e]=n==null?"":typeof n!="number"||St.test(e)?n:n+"px"}function te(t,e,n,o,s){var r,a;e:if(e=="style")if(typeof n=="string")t.style.cssText=n;else{if(typeof o=="string"&&(t.style.cssText=o=""),o)for(e in o)n&&e in n||Ue(t.style,e,"");if(n)for(e in n)o&&n[e]==o[e]||Ue(t.style,e,n[e])}else if(e[0]=="o"&&e[1]=="n")r=e!=(e=e.replace(et,"$1")),a=e.toLowerCase(),e=a in t||e=="onFocusOut"||e=="onFocusIn"?a.slice(2):e.slice(2),t.l||(t.l={}),t.l[e+r]=n,n?o?n[Q]=o[Q]:(n[Q]=xe,t.addEventListener(e,r?Ee:Se,r)):t.removeEventListener(e,r?Ee:Se,r);else{if(s=="http://www.w3.org/2000/svg")e=e.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(e!="width"&&e!="height"&&e!="href"&&e!="list"&&e!="form"&&e!="tabIndex"&&e!="download"&&e!="rowSpan"&&e!="colSpan"&&e!="role"&&e!="popover"&&e in t)try{t[e]=n??"";break e}catch{}typeof n=="function"||(n==null||n===!1&&e[4]!="-"?t.removeAttribute(e):t.setAttribute(e,e=="popover"&&n==1?"":n))}}function Me(t){return function(e){if(this.l){var n=this.l[e.type+t];if(e[re]==null)e[re]=xe++;else if(e[re]<n[Q])return;return n(g.event?g.event(e):e)}}}function Ae(t,e,n,o,s,r,a,l,_,c){var d,v,i,u,$,h,w,k,m,y,F,L,B,j,P,V,T=e.type;if(e.constructor!==void 0)return null;128&n.__u&&(_=!!(32&n.__u),r=[l=e.__e=n.__e]),(d=g.__b)&&d(e);e:if(typeof T=="function"){v=a.length;try{if(m=e.props,y=T.prototype&&T.prototype.render,F=(d=T.contextType)&&o[d.__c],L=d?F?F.props.value:d.__:o,n.__c?k=(i=e.__c=n.__c).__=i.__E:(y?e.__c=i=new T(m,L):(e.__c=i=new se(m,L),i.constructor=T,i.render=At),F&&F.sub(i),i.state||(i.state={}),i.__n=o,u=i.__d=!0,i.__h=[],i._sb=[]),y&&i.__s==null&&(i.__s=i.state),y&&T.getDerivedStateFromProps!=null&&(i.__s==i.state&&(i.__s=R({},i.__s)),R(i.__s,T.getDerivedStateFromProps(m,i.__s))),$=i.props,h=i.state,i.__v=e,u)y&&T.getDerivedStateFromProps==null&&i.componentWillMount!=null&&i.componentWillMount(),y&&i.componentDidMount!=null&&i.__h.push(i.componentDidMount);else{if(y&&T.getDerivedStateFromProps==null&&m!==$&&i.componentWillReceiveProps!=null&&i.componentWillReceiveProps(m,L),e.__v==n.__v||!i.__e&&i.shouldComponentUpdate!=null&&i.shouldComponentUpdate(m,i.__s,L)===!1){e.__v!=n.__v&&(i.props=m,i.state=i.__s,i.__d=!1),e.__e=n.__e,e.__k=n.__k,e.__k.some(function(D){D&&(D.__=e)}),ce.push.apply(i.__h,i._sb),i._sb=[],i.__h.length&&a.push(i),l=q(n);break e}i.componentWillUpdate!=null&&i.componentWillUpdate(m,i.__s,L),y&&i.componentDidUpdate!=null&&i.__h.push(function(){i.componentDidUpdate($,h,w)})}if(i.context=L,i.props=m,i.__P=t,i.__e=!1,B=g.__r,j=0,y)i.state=i.__s,i.__d=!1,B&&B(e),d=i.render(i.props,i.state,i.context),ce.push.apply(i.__h,i._sb),i._sb=[];else do i.__d=!1,B&&B(e),d=i.render(i.props,i.state,i.context),i.state=i.__s;while(i.__d&&++j<25);i.state=i.__s,i.getChildContext!=null&&(o=R(R({},o),i.getChildContext())),y&&!u&&i.getSnapshotBeforeUpdate!=null&&(w=i.getSnapshotBeforeUpdate($,h)),P=d!=null&&d.type===fe&&d.key==null?at(d.props.children):d,l=rt(t,pe(P)?P:[P],e,n,o,s,r,a,l,_,c),i.base=e.__e,e.__u&=-161,i.__h.length&&a.push(i),k&&(i.__E=i.__=null)}catch(D){if(a.length=v,e.__v=null,_||r!=null){if(D.then){for(e.__u|=_?160:128;l&&l.nodeType==8&&l.nextSibling;)l=l.nextSibling;r!=null&&(r[r.indexOf(l)]=null),e.__e=l}else if(r!=null)for(V=r.length;V--;)Te(r[V])}else e.__e=n.__e;e.__k==null&&(e.__k=n.__k||[]),D.then||st(e),g.__e(D,e,n)}}else r==null&&e.__v==n.__v?(e.__k=n.__k,e.__e=n.__e):l=e.__e=Tt(n.__e,e,n,o,s,r,a,_,c);return(d=g.diffed)&&d(e),128&e.__u?void 0:l}function st(t){t&&(t.__c&&(t.__c.__e=!0),t.__k&&t.__k.some(st))}function it(t,e,n){for(var o=0;o<n.length;o++)Ne(n[o],n[++o],n[++o]);g.__c&&g.__c(e,t),t.some(function(s){try{t=s.__h,s.__h=[],t.some(function(r){r.call(s)})}catch(r){g.__e(r,s.__v)}})}function at(t){return typeof t!="object"||t==null||t.__b>0?t:pe(t)?t.map(at):t.constructor!==void 0?null:R({},t)}function Tt(t,e,n,o,s,r,a,l,_){var c,d,v,i,u,$,h,w=n.props||ae,k=e.props,m=e.type;if(m=="svg"?s="http://www.w3.org/2000/svg":m=="math"?s="http://www.w3.org/1998/Math/MathML":s||(s="http://www.w3.org/1999/xhtml"),r!=null){for(c=0;c<r.length;c++)if((u=r[c])&&"setAttribute"in u==!!m&&(m?u.localName==m:u.nodeType==3)){t=u,r[c]=null;break}}if(t==null){if(m==null)return document.createTextNode(k);t=document.createElementNS(s,m,k.is&&k),l&&(g.__m&&g.__m(e,r),l=!1),r=null}if(m==null)w===k||l&&t.data==k||(t.data=k);else{if(r=m=="textarea"&&k.defaultValue!=null?null:r&&de.call(t.childNodes),!l&&r!=null)for(w={},c=0;c<t.attributes.length;c++)w[(u=t.attributes[c]).name]=u.value;for(c in w)u=w[c],c=="dangerouslySetInnerHTML"?v=u:c=="children"||c in k||c=="value"&&"defaultValue"in k||c=="checked"&&"defaultChecked"in k||te(t,c,null,u,s);for(c in k)u=k[c],c=="children"?i=u:c=="dangerouslySetInnerHTML"?d=u:c=="value"?$=u:c=="checked"?h=u:l&&typeof u!="function"||w[c]===u||te(t,c,u,w[c],s);if(d)l||v&&(d.__html==v.__html||d.__html==t.innerHTML)||(t.innerHTML=d.__html),e.__k=[];else if(v&&(t.innerHTML=""),rt(e.type=="template"?t.content:t,pe(i)?i:[i],e,n,o,m=="foreignObject"?"http://www.w3.org/1999/xhtml":s,r,a,r?r[0]:n.__k&&q(n,0),l,_),r!=null)for(c=r.length;c--;)Te(r[c]);l&&m!="textarea"||(c="value",m=="progress"&&$==null?t.removeAttribute("value"):$!=null&&($!==t[c]||m=="progress"&&!$||m=="option"&&$!=w[c])&&te(t,c,$,w[c],s),c="checked",h!=null&&h!=t[c]&&te(t,c,h,w[c],s))}return t}function Ne(t,e,n){try{if(typeof t=="function"){var o=typeof t.__u=="function";o&&t.__u(),o&&e==null||(t.__u=t(e))}else t.current=e}catch(s){g.__e(s,n)}}function ct(t,e,n){var o,s;if(g.unmount&&g.unmount(t),(o=t.ref)&&(o.current&&o.current!=t.__e||Ne(o,null,e)),(o=t.__c)!=null){if(o.componentWillUnmount)try{o.componentWillUnmount()}catch(r){g.__e(r,e)}o.base=o.__P=o.__n=null}if(o=t.__k)for(s=0;s<o.length;s++)o[s]&&ct(o[s],e,n||typeof t.type!="function");n||Te(t.__e),t.__c=t.__=t.__e=void 0}function At(t,e,n){return this.constructor(t,n)}function Nt(t,e,n){var o,s,r,a;e==document&&(e=document.documentElement),g.__&&g.__(t,e),s=(o=!1)?null:e.__k,r=[],a=[],Ae(e,t=e.__k=tt(fe,null,[t]),s||ae,ae,e.namespaceURI,s?null:e.firstChild?de.call(e.childNodes):null,r,s?s.__e:e.firstChild,o,a),it(r,t,a),t.props.children=null}de=ce.slice,g={__e:function(t,e,n,o){for(var s,r,a;e=e.__;)if((s=e.__c)&&!s.__)try{if((r=s.constructor)&&r.getDerivedStateFromError!=null&&(s.setState(r.getDerivedStateFromError(t)),a=s.__d),s.componentDidCatch!=null&&(s.componentDidCatch(t,o||{}),a=s.__d),a)return s.__E=s}catch(l){t=l}throw t}},Xe=0,se.prototype.setState=function(t,e){var n;n=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=R({},this.state),typeof t=="function"&&(t=t(R({},n),this.props)),t&&R(n,t),t!=null&&this.__v&&(e&&this._sb.push(e),Re(this))},se.prototype.forceUpdate=function(t){this.__v&&(this.__e=!0,t&&this.__h.push(t),Re(this))},se.prototype.render=fe,M=[],Ye=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,Ze=function(t,e){return t.__v.__b-e.__v.__b},le.__r=0,ke=Math.random().toString(8),re="__d"+ke,Q="__a"+ke,et=/(PointerCapture)$|Capture$/i,xe=0,Se=Me(!1),Ee=Me(!0);var lt=function(t,e,n,o){var s;e[0]=0;for(var r=1;r<e.length;r++){var a=e[r++],l=e[r]?(e[0]|=a?1:2,n[e[r++]]):e[++r];a===3?o[0]=l:a===4?o[1]=Object.assign(o[1]||{},l):a===5?(o[1]=o[1]||{})[e[++r]]=l:a===6?o[1][e[++r]]+=l+"":a?(s=t.apply(l,lt(t,l,n,["",null])),o.push(s),l[0]?e[0]|=2:(e[r-2]=0,e[r]=s)):o.push(l)}return o},Fe=new Map;function It(t){var e=Fe.get(this);return e||(e=new Map,Fe.set(this,e)),(e=lt(this,e.get(t)||(e.set(t,e=(function(n){for(var o,s,r=1,a="",l="",_=[0],c=function(i){r===1&&(i||(a=a.replace(/^\s*\n\s*|\s*\n\s*$/g,"")))?_.push(0,i,a):r===3&&(i||a)?(_.push(3,i,a),r=2):r===2&&a==="..."&&i?_.push(4,i,0):r===2&&a&&!i?_.push(5,0,!0,a):r>=5&&((a||!i&&r===5)&&(_.push(r,0,a,s),r=6),i&&(_.push(r,i,0,s),r=6)),a=""},d=0;d<n.length;d++){d&&(r===1&&c(),c(d));for(var v=0;v<n[d].length;v++)o=n[d][v],r===1?o==="<"?(c(),_=[_],r=3):a+=o:r===4?a==="--"&&o===">"?(r=1,a=""):a=o+a[0]:l?o===l?l="":a+=o:o==='"'||o==="'"?l=o:o===">"?(c(),r=1):r&&(o==="="?(r=5,s=a,a=""):o==="/"&&(r<5||n[d][v+1]===">")?(c(),r===3&&(_=_[0]),r=_,(_=_[0]).push(2,0,r),r=0):o===" "||o==="	"||o===`
`||o==="\r"?(c(),r=2):a+=o),r===3&&a==="!--"&&(r=4,_=_[0])}return c(),_})(t)),e),arguments,[])).length>1?e:e[0]}const p=It.bind(tt);var X,C,Ce,Be,_e=0,_t=[],S=g,je=S.__b,We=S.__r,qe=S.diffed,Ve=S.__c,Je=S.unmount,ze=S.__;function Ie(t,e){S.__h&&S.__h(C,t,_e||e),_e=0;var n=C.__H||(C.__H={__:[],__h:[]});return t>=n.__.length&&n.__.push({}),n.__[t]}function E(t){return _e=1,Lt(dt,t)}function Lt(t,e,n){var o=Ie(X++,2);if(o.t=t,!o.__c&&(o.__=[dt(void 0,e),function(l){var _=o.__N?o.__N[0]:o.__[0],c=o.t(_,l);_!==c&&(o.__N=[c,o.__[1]],o.__c.setState({}))}],o.__c=C,!C.__f)){var s=function(l,_,c){if(!o.__c.__H)return!0;var d=!1,v=o.__c.props!==l;if(o.__c.__H.__.some(function(u){if(u.__N){d=!0;var $=u.__[0];u.__=u.__N,u.__N=void 0,$!==u.__[0]&&(v=!0)}}),r){var i=r.call(this,l,_,c);return d?i||v:i}return!d||v};C.__f=!0;var r=C.shouldComponentUpdate,a=C.componentWillUpdate;C.componentWillUpdate=function(l,_,c){if(this.__e){var d=r;r=void 0,s(l,_,c),r=d}a&&a.call(this,l,_,c)},C.shouldComponentUpdate=s}return o.__N||o.__}function K(t,e){var n=Ie(X++,3);!S.__s&&ut(n.__H,e)&&(n.__=t,n.u=e,C.__H.__h.push(n))}function Pt(t,e){var n=Ie(X++,7);return ut(n.__H,e)&&(n.__=t(),n.__H=e,n.__h=t),n.__}function N(t,e){return _e=8,Pt(function(){return t},e)}function Dt(){for(var t;t=_t.shift();){var e=t.__H;if(t.__P&&e)try{e.__h.some(ie),e.__h.some(Oe),e.__h=[]}catch(n){e.__h=[],S.__e(n,t.__v)}}}S.__b=function(t){C=null,je&&je(t)},S.__=function(t,e){t&&e.__k&&e.__k.__m&&(t.__m=e.__k.__m),ze&&ze(t,e)},S.__r=function(t){We&&We(t),X=0;var e=(C=t.__c).__H;e&&(Ce===C?(e.__h=[],C.__h=[],e.__.some(function(n){n.__N&&(n.__=n.__N),n.u=n.__N=void 0})):(e.__h.some(ie),e.__h.some(Oe),e.__h=[],X=0)),Ce=C},S.diffed=function(t){qe&&qe(t);var e=t.__c;e&&e.__H&&(e.__H.__h.length&&(_t.push(e)!==1&&Be===S.requestAnimationFrame||((Be=S.requestAnimationFrame)||Ht)(Dt)),e.__H.__.some(function(n){n.u&&(n.__H=n.u,n.u=void 0)})),Ce=C=null},S.__c=function(t,e){e.some(function(n){try{n.__h.some(ie),n.__h=n.__h.filter(function(o){return!o.__||Oe(o)})}catch(o){e.some(function(s){s.__h&&(s.__h=[])}),e=[],S.__e(o,n.__v)}}),Ve&&Ve(t,e)},S.unmount=function(t){Je&&Je(t);var e,n=t.__c;n&&n.__H&&(n.__H.__.some(function(o){try{ie(o)}catch(s){e=s}}),n.__H=void 0,e&&S.__e(e,n.__v))};var Ge=typeof requestAnimationFrame=="function";function Ht(t){var e,n=function(){clearTimeout(o),Ge&&cancelAnimationFrame(e),setTimeout(t)},o=setTimeout(n,35);Ge&&(e=requestAnimationFrame(n))}function ie(t){var e=C,n=t.__c;typeof n=="function"&&(t.__c=void 0,n()),C=e}function Oe(t){var e=C;t.__c=t.__(),C=e}function ut(t,e){return!t||t.length!==e.length||e.some(function(n,o){return n!==t[o]})}function dt(t,e){return typeof e=="function"?e(t):e}function I(t,e=8){return typeof t!="string"||t===""?"-":t.length<=e?t:`${t.slice(0,e)}…`}function Rt(t,e=16){if(typeof t!="string"||t==="")return"";const n="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",o=[];let s=0,r=0;for(const a of t){const l=n.indexOf(a);if(l===-1)return"";s=s<<6|l,r+=6,r>=8&&(r-=8,o.push(s>>>r&255))}return o.slice(0,Math.ceil(e/2)).map(a=>a.toString(16).padStart(2,"0")).join("").slice(0,e)}function ue(t){if(typeof t!="string")return null;const e=t.trim().toLowerCase();return/^[0-9a-f]{64}$/.test(e)?e:null}function Ut(t){const e=typeof t?.code=="string"?t.code:"",n=typeof t?.message=="string"?t.message:"";switch(e){case"admin-not-enabled":return{title:"远端未启用管理面",detail:"目标服务器未配置 DWEB_ADMIN_TOKEN（/admin/* 未挂载，404）。请在服务端配置该环境变量并重启服务器后重试。",retry:!0};case"unauthorized":return{title:"token 无效",detail:"目标已冻结——当前 sidecar 生命周期内无法更换 token。请重启 sidecar 并使用有效的 DWEB_ADMIN_TOKEN 重新连接。",retry:!1};case"no-match":return{title:"目标不存在",detail:"所操作的 endpoint / fabric 不在线或已被移除（no-match）。请刷新在线表后重试。",retry:!0};case"timeout":return{title:"请求超时",detail:"上游响应超时——请检查 sidecar 与目标服务器的连通性后重试。",retry:!0};case"network":return{title:"网络错误",detail:"无法到达目标（网络错误）——请检查 sidecar 与目标服务器的连通性后重试。",retry:!0};default:return e.startsWith("http-5")?{title:"上游服务错误",detail:`目标返回 ${e||"http-5xx"}——请稍后重试；持续失败请检查远端服务器状态。`,retry:!0}:{title:"请求失败",detail:`${e||"unknown"}${n?`：${n}`:""}——请重试。`,retry:!0}}}function Mt(t){const e=typeof t?.code=="string"?t.code:"";switch(e){case"bad-pairing":return{title:"配对码错误或已失效",detail:"请对照 sidecar 终端输出重新抄录一次性配对码。连续失败 5 次配对码将被销毁——销毁后需重启 sidecar 重新生成。"};case"bad-target":return{title:"目标 URL 被拒绝",detail:`${t?.message??""}（仅接受绝对 http(s) URL；明文 http 公网目标需 sidecar 以 --allow-insecure 启动）`};case"bad-origin-host":return{title:"来源校验失败",detail:"请确认浏览器从 sidecar 终端打印的 URL 原样打开本页面（Host/Origin 校验未通过）。"};case"invalid-request":return{title:"提交不完整",detail:"服务器 URL 与 admin token 均为必填。"};case"target-frozen":return{title:"目标已冻结",detail:"本 sidecar 已连接目标且生命周期内不可更改。如需重新指向，请重启 sidecar。"};default:return{title:"连接失败",detail:`${e}：${t?.message??""}`}}}function Y({error:t,onRetry:e}){if(t==null)return null;const n=Ut(t);return p`
    <div class="error-banner" role="alert">
      <div class="banner-title">${n.title}</div>
      <div class="banner-detail">${n.detail}</div>
      ${n.retry&&e?p`<button class="ghost" onClick=${e}>重试</button>`:null}
    </div>
  `}function he(){return p`
    <div class="insecure-banner" role="alert">
      <div class="banner-title">明文传输告警</div>
      <div class="banner-detail">
        目标经未加密的 http 连接（sidecar 以 --allow-insecure 启动）：admin token
        与管理流量在传输中未加密。建议改用 https 或 loopback 目标。
      </div>
    </div>
  `}function Le(){return p`
    <div class="setup-gate">
      <h2>未连接</h2>
      <p>尚未连接任何 dweb-server 目标（sidecar 处于 setup 模式）。</p>
      <p>
        前往
        <a href="#/connect">配对面</a>
        ，使用 sidecar 终端打印的一次性配对码连接服务器后再查看本页。
      </p>
    </div>
  `}function pt({title:t,confirmLabel:e="确认",danger:n=!1,onCancel:o,onConfirm:s,children:r}){return p`
    <div class="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>${t}</h3>
        <div class="dialog-body">${r}</div>
        <div class="dialog-actions">
          <button class="ghost" onClick=${o}>取消</button>
          <button class=${n?"danger":""} onClick=${s}>${e}</button>
        </div>
      </div>
    </div>
  `}function ft({receipt:t,onCopy:e}){const n=t??{},o=n.op==="disconnect"?n.endpoint_id:n.root,s=typeof n.ts=="number"?new Date(n.ts).toISOString():"-";return p`
    <div class="receipt-card" data-op=${n.op??"unknown"}>
      <span class="badge">${n.op??"-"}</span>
      <dl class="receipt-fields">
        <dt>时间</dt>
        <dd>${s}</dd>
        <dt>generation</dt>
        <dd>${n.generation??"-"}</dd>
        <dt>目标</dt>
        <dd class="mono">${I(o)}</dd>
        <dt>签名前缀</dt>
        <dd class="mono">${Rt(n.receipt_sig)||"-"}</dd>
        ${typeof n.kicked_connections=="number"?p`<dt>踢除连接</dt><dd>${n.kicked_connections}</dd>`:null}
      </dl>
      ${e?p`<button class="ghost small" onClick=${()=>e(n)}>复制全文</button>`:null}
    </div>
  `}function Ft({state:t,form:e,busy:n,result:o,onInput:s,onSubmit:r,onGoStatus:a}){if(t!==null&&t.phase==="ready")return p`
      <section class="view" data-view="connect">
        <h2>服务器连接</h2>
        <div class="success-banner">
          <div class="banner-title">已连接</div>
          <div class="banner-detail">
            目标 <span class="mono">${t.server_host_masked??"-"}</span>
            ——目标已冻结（本 sidecar 生命周期内不可更改；重新指向需重启 sidecar）。
          </div>
          <button onClick=${a}>前往状态页</button>
        </div>
      </section>
    `;const l=o!==null&&o.ok===!1?Mt(o.error):null;return p`
    <section class="view" data-view="connect">
      <h2>连接 dweb-server</h2>
      <p class="hint">
        从 sidecar 终端输出抄录<strong>一次性配对码</strong>填入下方表单。admin token
        仅随本请求提交一次，由 sidecar 进程持有——浏览器不保存、不回显。
      </p>
      ${l!==null?p`
            <div class="error-banner" role="alert">
              <div class="banner-title">${l.title}</div>
              <div class="banner-detail">${l.detail}</div>
            </div>
          `:null}
      <form class="stack" onSubmit=${_=>{_.preventDefault(),r()}}>
        <label>
          配对码（终端打印，单次有效 10 分钟）
          <input
            name="code"
            value=${e.code}
            onInput=${_=>s("code",_.currentTarget.value)}
            autocomplete="off"
            spellcheck="false"
            placeholder="13 位大写字母/数字"
          />
        </label>
        <label>
          服务器 URL（绝对 http(s)，如 https://srv.example:18787）
          <input
            name="server"
            value=${e.server}
            onInput=${_=>s("server",_.currentTarget.value)}
            autocomplete="off"
            spellcheck="false"
            placeholder="https://srv.example:18787"
          />
        </label>
        <label>
          admin token（DWEB_ADMIN_TOKEN）
          <input
            name="token"
            type="password"
            value=${e.token}
            onInput=${_=>s("token",_.currentTarget.value)}
            autocomplete="off"
            placeholder="提交后即清空，不回显"
          />
        </label>
        <button type="submit" disabled=${n||e.code===""||e.server===""||e.token===""}>
          ${n?"连接中…":"连接"}
        </button>
      </form>
    </section>
  `}function Bt({state:t,data:e,error:n,onRetry:o}){if(t!==null&&t.phase!=="ready")return p`<${Le}/>`;const s=Array.isArray(e?.active_connections)?e.active_connections:[],r=Array.isArray(e?.per_owner_connections)?e.per_owner_connections:[],a=s.reduce((l,_)=>l+(Number(_?.connections)||0),0);return p`
    <section class="view" data-view="status">
      <h2>服务器总览</h2>
      ${t?.insecure===!0?p`<${he}/>`:null}
      ${n!=null?p`<${Y} error=${n} onRetry=${o}/>`:null}
      ${e===null?p`<p class="loading">加载中…</p>`:p`
            <div class="cards">
              <div class="card">
                <div class="card-label">目标</div>
                <div class="card-value mono">${t?.server_host_masked??"-"}</div>
              </div>
              <div class="card">
                <div class="card-label">模式（mode）</div>
                <div class="card-value"><span class="badge">${e.mode??"-"}</span></div>
              </div>
              <div class="card">
                <div class="card-label">策略（policy）</div>
                <div class="card-value">${e.policy??"-"}</div>
              </div>
              <div class="card">
                <div class="card-label">generation</div>
                <div class="card-value mono">${e.generation??"-"}</div>
              </div>
              <div class="card">
                <div class="card-label">owner 数</div>
                <div class="card-value mono">${r.length}</div>
              </div>
              <div class="card">
                <div class="card-label">在线 endpoint</div>
                <div class="card-value mono">${s.length}（连接 ${a}）</div>
              </div>
              <div class="card">
                <div class="card-label">每 owner 连接上限</div>
                <div class="card-value mono">${e.max_connections_per_owner??"-"}</div>
              </div>
              <div class="card">
                <div class="card-label">缓存条目</div>
                <div class="card-value mono">${e.cache_entries??"-"}</div>
              </div>
            </div>
          `}
    </section>
  `}function jt(t){const{state:e,data:n,error:o,form:s,formError:r,busy:a,receipt:l,confirm:_}=t,{onInput:c,onRegister:d,onAskUnregister:v,onConfirmUnregister:i,onCancelConfirm:u,onCopy:$,onRetry:h}=t;if(e!==null&&e.phase!=="ready")return p`<${Le}/>`;const w=Array.isArray(n?.owners)?n.owners:[],k=ue(s.fabricId)!==null||s.fabricId==="",m=ue(s.root)!==null||s.root==="";return p`
    <section class="view" data-view="owners">
      <h2>Owners 注册表 <span class="sub">generation ${n?.generation??"-"}</span></h2>
      ${e?.insecure===!0?p`<${he}/>`:null}
      ${o!=null?p`<${Y} error=${o} onRetry=${h}/>`:null}
      <table>
        <thead>
          <tr><th>fabric_id</th><th>root</th><th>注册时间</th><th></th></tr>
        </thead>
        <tbody>
          ${w.length===0?p`<tr><td colspan="4" class="empty">（空）</td></tr>`:w.map(y=>p`
                  <tr key=${y.fabric_id+y.root}>
                    <td class="mono" title=${y.fabric_id}>${I(y.fabric_id)}</td>
                    <td class="mono" title=${y.root}>${I(y.root)}</td>
                    <td>${typeof y.registered_at=="number"?new Date(y.registered_at).toISOString():"-"}</td>
                    <td class="actions">
                      <button
                        class="danger ghost small"
                        onClick=${()=>v(y)}
                      >注销</button>
                    </td>
                  </tr>
                `)}
        </tbody>
      </table>
      <form class="stack" onSubmit=${y=>{y.preventDefault(),d()}}>
        <h3>注册 Owner</h3>
        <label>
          fabric_id（64 hex）
          <input
            name="fabricId"
            class=${k?"":"invalid"}
            value=${s.fabricId}
            onInput=${y=>c("fabricId",y.currentTarget.value)}
            autocomplete="off" spellcheck="false" placeholder="64 位十六进制字符"
          />
        </label>
        <label>
          root（64 hex）
          <input
            name="root"
            class=${m?"":"invalid"}
            value=${s.root}
            onInput=${y=>c("root",y.currentTarget.value)}
            autocomplete="off" spellcheck="false" placeholder="64 位十六进制字符"
          />
        </label>
        ${r!==null?p`<p class="field-error" role="alert">${r}</p>`:null}
        <button
          type="submit"
          disabled=${a||s.fabricId===""||s.root===""||!k||!m}
        >${a?"提交中…":"注册"}</button>
      </form>
      ${l!==null?p`
            <div class="receipt-area">
              <h3>变更回执</h3>
              <${ft} receipt=${l} onCopy=${$}/>
            </div>
          `:null}
      ${_!==null?p`
            <${pt}
              title="确认注销 Owner？"
              confirmLabel="确认注销"
              danger=${!0}
              onCancel=${u}
              onConfirm=${i}
            >
              <p>将注销以下 (fabric_id, root) 二元组，其存量连接将被断开：</p>
              <p class="mono">fabric ${I(_.fabricId)} / root ${I(_.root)}</p>
            <//>
          `:null}
    </section>
  `}const Wt={dispatched:"已下发",converging:"收敛中",converged:"已收敛",unconfirmed:"超时未确认"};function qt(t){const{state:e,data:n,error:o,confirm:s,disconnect:r}=t,{onAskDisconnect:a,onConfirmDisconnect:l,onCancelConfirm:_,onCopy:c,onRetry:d}=t;if(e!==null&&e.phase!=="ready")return p`<${Le}/>`;const v=Array.isArray(n?.per_endpoint)?n.per_endpoint:[],i=Array.isArray(n?.per_owner)?n.per_owner:[],u=n?.quota??{},$=u.configured===!0?u.max_connections_per_owner??"-":"未配置";return p`
    <section class="view" data-view="connections">
      <h2>在线连接</h2>
      ${e?.insecure===!0?p`<${he}/>`:null}
      ${o!=null?p`<${Y} error=${o} onRetry=${d}/>`:null}
      ${r!==null?p`
            <div class="disconnect-panel">
              <span class="badge phase-${r.phase}">
                ${Wt[r.phase]??r.phase}
              </span>
              <span class="mono">${I(r.id)}</span>
              （按 ${r.kind==="endpoint"?"endpoint":"fabric"} 断开）
              ${r.error!==null&&r.error!==void 0?p`<${Y} error=${r.error}/>`:null}
              ${r.phase==="converging"?p`<span class="hint">断开为 best-effort——正在以有界轮询观测在线表收敛…</span>`:null}
              ${Array.isArray(r.receipts)&&r.receipts.length>0?p`
                    <div class="receipt-area">
                      <h3>per-target 回执</h3>
                      ${r.receipts.map((h,w)=>p`<${ft} key=${w} receipt=${h} onCopy=${c}/>`)}
                    </div>
                  `:null}
            </div>
          `:null}
      ${n===null?p`<p class="loading">加载中…</p>`:p`
            <p class="hint">
              mode <span class="badge">${n.mode??"-"}</span>
              · relay ${n.relay_enabled===!0?"已启用":"未启用"}
              · 配额（每 owner 在用 / 上限）：<span class="mono">${$}</span>
            </p>
            <h3>按 endpoint</h3>
            <table>
              <thead><tr><th>endpoint_id</th><th>fabric_id</th><th>连接数</th><th></th></tr></thead>
              <tbody>
                ${v.length===0?p`<tr><td colspan="4" class="empty">（无在线连接）</td></tr>`:v.map(h=>p`
                        <tr key=${h.endpoint_id+h.fabric_id}>
                          <td class="mono" title=${h.endpoint_id}>${I(h.endpoint_id)}</td>
                          <td class="mono" title=${h.fabric_id}>${I(h.fabric_id)}</td>
                          <td class="mono">${h.connections}</td>
                          <td class="actions">
                            <button
                              class="danger ghost small"
                              onClick=${()=>a("endpoint",h.endpoint_id,h.connections)}
                            >断连</button>
                          </td>
                        </tr>
                      `)}
              </tbody>
            </table>
            <h3>按 owner</h3>
            <table>
              <thead><tr><th>fabric_id</th><th>在用 / 上限</th><th></th></tr></thead>
              <tbody>
                ${i.length===0?p`<tr><td colspan="3" class="empty">（无在线 owner）</td></tr>`:i.map(h=>p`
                        <tr key=${h.fabric_id}>
                          <td class="mono" title=${h.fabric_id}>${I(h.fabric_id)}</td>
                          <td class="mono">${h.connections} / ${$}</td>
                          <td class="actions">
                            <button
                              class="danger ghost small"
                              onClick=${()=>a("fabric",h.fabric_id,h.connections)}
                            >断连全部</button>
                          </td>
                        </tr>
                      `)}
              </tbody>
            </table>
          `}
      ${s!==null?p`
            <${pt}
              title="确认断开连接？"
              confirmLabel="确认断连"
              danger=${!0}
              onCancel=${_}
              onConfirm=${l}
            >
              <p>将向目标服务器下发断开指令（best-effort，异步收敛）：</p>
              <p>
                ${s.kind==="endpoint"?"endpoint":"owner fabric"}
                <span class="mono">${I(s.id)}</span>
                · 当前连接数 <span class="mono">${s.count}</span>
              </p>
            <//>
          `:null}
    </section>
  `}class z extends Error{constructor(e,n,o=null){super(n),this.name="AdminError",this.code=e,this.status=o}static async fromResponse(e){let n=null,o=null;try{const s=JSON.parse(await e.text()),r=s&&typeof s=="object"?s.error:null;r&&typeof r=="object"&&typeof r.code=="string"&&typeof r.message=="string"&&(n=r.code,o=r.message)}catch{}return n===null&&(n=`http-${e.status}`),o===null&&(o=e.statusText&&e.statusText!==""?`HTTP ${e.status} ${e.statusText}`:`HTTP ${e.status}`),new z(n,o,e.status)}}let Vt=Jt;function Jt(t,e={}){return fetch(t,{...e,signal:e.signal??AbortSignal.timeout(15e3)})}function zt(t){const e=t&&typeof t=="object"?t.name:null;if(e==="TimeoutError"||e==="AbortError")return new z("timeout","request timed out",null);const n=t instanceof Error?t.message:String(t??"unknown error");return new z("network",`request failed: ${n}`,null)}async function U(t,e){let n;try{n=await Vt(t,e)}catch(s){throw zt(s)}if(!n.ok)throw await z.fromResponse(n);const o=await n.text();try{return JSON.parse(o)}catch{throw new z("invalid-response",`response body is not JSON (status ${n.status})`,n.status)}}function Gt(){return U("/sidecar/state")}function Kt(t){return U("/sidecar/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(t)})}function Qt(){return U("/api/status")}function Xt(){return U("/api/owners")}function Ke(){return U("/api/connections")}function Yt(t,e){return U("/api/owners",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({fabric_id_hex:t,root_hex:e})})}function Zt(t,e){return U(`/api/owners/${t}/${e}`,{method:"DELETE"})}function en(t){return U("/api/connections/disconnect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({endpoint_id:t})})}function tn(t){return U("/api/connections/disconnect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({fabric_id:t})})}const Qe=5e3,nn=1e3,rn=15,on=["connect","status","owners","connections"];function sn(t,e){const n=String(t??"").replace(/^#\/?/,"");return on.includes(n)?n:e==="ready"?"status":"connect"}const ne=()=>document.visibilityState==="visible",an=t=>new Promise(e=>setTimeout(e,t));function cn(t,e,n){return(Array.isArray(t?.per_endpoint)?t.per_endpoint:[]).some(s=>e==="endpoint"?s.endpoint_id===n:s.fabric_id===n)}function ln(){const[t,e]=E(()=>location.hash),[n,o]=E(null),[s,r]=E(null),[a,l]=E({server:"",token:"",code:""}),[_,c]=E(!1),[d,v]=E(null),[i,u]=E(null),[$,h]=E(null),[w,k]=E(null),[m,y]=E(null),[F,L]=E(null),[B,j]=E(null),[P,V]=E({fabricId:"",root:""}),[T,D]=E(null),[ht,Z]=E(!1),[vt,Pe]=E(null),[ve,me]=E(null),[ye,$e]=E(null),[mt,ee]=E(null),H=n!==null&&n.phase==="ready"?"ready":"setup",x=sn(t,H);K(()=>{const f=()=>e(location.hash);return window.addEventListener("hashchange",f),()=>window.removeEventListener("hashchange",f)},[]);const G=N(async()=>{try{o(await Gt()),r(null)}catch(f){r(f)}},[]);K(()=>{G()},[G]);const be=N(async()=>{try{u(await Qt()),h(null)}catch(f){h(f)}},[]);K(()=>{if(x!=="status"||H!=="ready")return;let f=!1;const b=async()=>{f||!ne()||be()};b();const O=setInterval(b,Qe),A=()=>{ne()&&b()};return document.addEventListener("visibilitychange",A),()=>{f=!0,clearInterval(O),document.removeEventListener("visibilitychange",A)}},[x,H,be]);const ge=N(async()=>{try{k(await Ke()),y(null)}catch(f){y(f)}},[]);K(()=>{if(x!=="connections"||H!=="ready")return;let f=!1;const b=async()=>{f||!ne()||ge()};b();const O=setInterval(b,Qe),A=()=>{ne()&&b()};return document.addEventListener("visibilitychange",A),()=>{f=!0,clearInterval(O),document.removeEventListener("visibilitychange",A)}},[x,H,ge]);const W=N(async()=>{try{L(await Xt()),j(null)}catch(f){j(f)}},[]);K(()=>{x==="owners"&&H==="ready"&&W()},[x,H,W]);const yt=N((f,b)=>{l(O=>({...O,[f]:b}))},[]),$t=N(async()=>{c(!0),v(null);try{await Kt({pairing_code:a.code.trim(),server:a.server.trim(),token:a.token}),l(f=>({...f,token:"",code:""})),v({ok:!0}),await G(),location.hash="#/status"}catch(f){v({ok:!1,error:f})}finally{c(!1)}},[a,G]),bt=N((f,b)=>{V(O=>({...O,[f]:b}))},[]),gt=N(async()=>{const f=ue(P.fabricId),b=ue(P.root);if(f===null||b===null){D("fabric_id 与 root 均须为 64 位十六进制字符（0-9 / a-f）");return}D(null),Z(!0);try{Pe(await Yt(f,b)),V({fabricId:"",root:""}),await W()}catch(O){j(O)}finally{Z(!1)}},[P,W]),wt=N(async()=>{const{fabricId:f,root:b}=ve??{};if(me(null),f!==void 0){Z(!0);try{Pe(await Zt(f,b)),await W()}catch(O){j(O)}finally{Z(!1)}}},[ve,W]),kt=N(async()=>{const{kind:f,id:b}=ye??{};if($e(null),b!==void 0){ee({kind:f,id:b,phase:"dispatched",receipts:[],error:null});try{const O=f==="endpoint"?await en(b):await tn(b);ee({kind:f,id:b,phase:"converging",receipts:O?.receipts??[],error:null});let A=!1;for(let J=0;J<rn;J++){await an(nn);let we;try{we=await Ke(),k(we),y(null)}catch{continue}if(!cn(we,f,b)){A=!0;break}}const Ct=A?"converged":"unconfirmed";ee(J=>J===null?J:{...J,phase:Ct})}catch(O){ee(A=>A===null?A:{...A,error:O})}}},[ye]),De=N(async f=>{const b=JSON.stringify(f,null,2);try{await navigator.clipboard.writeText(b)}catch{}},[]);return n===null&&s!==null?p`
      <div class="boot-error">
        <${Y} error=${s} onRetry=${G}/>
        <p class="hint">无法取得 sidecar 状态——请确认 sidecar 进程仍在运行，或从终端重新打开其 URL。</p>
      </div>
    `:n===null?p`<div class="boot-loading">加载中…</div>`:p`
    <div class="shell">
      <header class="topbar">
        <span class="brand">opendweb 管理控制台</span>
        <span class="phase ${H==="ready"?"ok":""}">
          ${H==="ready"?p`已连接 <span class="mono">${n.server_host_masked}</span>`:"未连接"}
        </span>
        <nav>
          <a class=${x==="connect"?"active":""} href="#/connect">配对</a>
          <a class=${x==="status"?"active":""} href="#/status">状态</a>
          <a class=${x==="owners"?"active":""} href="#/owners">Owners</a>
          <a class=${x==="connections"?"active":""} href="#/connections">在线连接</a>
        </nav>
      </header>
      ${n.insecure===!0?p`<${he}/>`:null}
      <main>
        ${x==="connect"?p`
              <${Ft}
                state=${n}
                form=${a}
                busy=${_}
                result=${d}
                onInput=${yt}
                onSubmit=${$t}
                onGoStatus=${()=>{location.hash="#/status"}}
              />
            `:x==="status"?p`
                <${Bt}
                  state=${n}
                  data=${i}
                  error=${$}
                  onRetry=${be}
                />
              `:x==="owners"?p`
                  <${jt}
                    state=${n}
                    data=${F}
                    error=${B}
                    form=${P}
                    formError=${T}
                    busy=${ht}
                    receipt=${vt}
                    confirm=${ve}
                    onInput=${bt}
                    onRegister=${gt}
                    onAskUnregister=${me}
                    onConfirmUnregister=${wt}
                    onCancelConfirm=${()=>me(null)}
                    onCopy=${De}
                    onRetry=${W}
                  />
                `:p`
                  <${qt}
                    state=${n}
                    data=${w}
                    error=${m}
                    confirm=${ye}
                    disconnect=${mt}
                    onAskDisconnect=${(f,b,O)=>$e({kind:f,id:b,count:O})}
                    onConfirmDisconnect=${kt}
                    onCancelConfirm=${()=>$e(null)}
                    onCopy=${De}
                    onRetry=${ge}
                  />
                `}
      </main>
    </div>
  `}Nt(p`<${ln}/>`,document.getElementById("app"));
