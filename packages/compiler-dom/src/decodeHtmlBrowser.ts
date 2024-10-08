/* eslint-disable no-restricted-globals */

let decoder: HTMLDivElement

/**
 * 对内容进行实体解码
 * 因为el.textContent = content  是不支持实体解码的，比如 el.textContent = '1&lt;=2' 理论上应该显示为 '1<=2'，但是通过textContent赋值后显示为 '1&lt;=2'，不会对html实体解码
 * 这里通过innerHTML赋值后，会对html实体解码。
 * 所以这里的做法，是先创建一个div，然后通过innerHTML赋值，再返回这个内容就是解码实体后的内容
 * @param raw 源字符串内容
 * @param asAttr 是否是属性
 * @returns 返回实体解码后的内容
 * 属性分两种情况，如果是有分号的，然后要进行html实体解码，但是如果没有分号，就不要解码，比如：
 * <a id="link" href="foo.com?a=1&lt=2">1&lt=2</a>  显示的是   <a id="link" href="foo.com?a=1&amp;lt=2">1<=2</a>
 * <a id="link" href="foo.com?a=1&lt;=2">1&lt=2</a>  <a id="link" href="foo.com?a=1<=2">1<=2</a>
 */
export function decodeHtmlBrowser(raw: string, asAttr = false): string {
  if (!decoder) {
    decoder = document.createElement('div')
  }
  if (asAttr) {
    decoder.innerHTML = `<div foo="${raw.replace(/"/g, '&quot;')}">`
    return decoder.children[0].getAttribute('foo')!
  } else {
    decoder.innerHTML = raw
    return decoder.textContent!
  }
}
