import{c as o}from"./chunk-chunk-ETFFNZMI.js";import"./chunk-chunk-WGIGM23C.js";import"./chunk-chunk-Q5DOJI7H.js";var g="ionKeyboardDidShow",f="ionKeyboardDidHide",a={},t={},s=!1,u=()=>{a={},t={},s=!1},v=e=>{if(o.getEngine())b(e);else{if(!e.visualViewport)return;t=h(e.visualViewport),e.visualViewport.onresize=()=>{l(e),w()||y(e)?d(e):n(e)&&r(e)}}},b=e=>{e.addEventListener("keyboardDidShow",(i=>d(e,i))),e.addEventListener("keyboardDidHide",(()=>r(e)))},d=(e,i)=>{D(e,i),s=!0},r=e=>{c(e),s=!1},w=()=>!s&&a.width===t.width&&(a.height-t.height)*t.scale>150,y=e=>s&&!n(e),n=e=>s&&t.height===e.innerHeight,D=(e,i)=>{let p=new CustomEvent(g,{detail:{keyboardHeight:i?i.keyboardHeight:e.innerHeight-t.height}});e.dispatchEvent(p)},c=e=>{let i=new CustomEvent(f);e.dispatchEvent(i)},l=e=>{a=Object.assign({},t),t=h(e.visualViewport)},h=e=>({width:Math.round(e.width),height:Math.round(e.height),offsetTop:e.offsetTop,offsetLeft:e.offsetLeft,pageTop:e.pageTop,pageLeft:e.pageLeft,scale:e.scale});export{f as KEYBOARD_DID_CLOSE,g as KEYBOARD_DID_OPEN,h as copyVisualViewport,n as keyboardDidClose,w as keyboardDidOpen,y as keyboardDidResize,u as resetKeyboardAssist,r as setKeyboardClose,d as setKeyboardOpen,v as startKeyboardAssist,l as trackViewportChanges};
/*! Bundled license information:

@ionic/core/components/p-D6Ynv7Xh.js:
  (*!
   * (C) Ionic http://ionicframework.com - MIT License
   *)
*/
//# sourceMappingURL=chunk-p-D6Ynv7Xh-RBNWDNTZ.js.map
