/**
 * This Tokenizer is adapted from htmlparser2 under the MIT License listed at
 * https://github.com/fb55/htmlparser2/blob/master/LICENSE

Copyright 2010, 2011, Chris Winberry <chris@winberry.net>. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
 */

import { ErrorCodes } from './errors'
import type { ElementNode, Position } from './ast'

/**
 * Note: entities is a non-browser-build-only dependency.
 * In the browser, we use an HTML element to do the decoding.
 * Make sure all imports from entities are only used in non-browser branches
 * so that it can be properly treeshaken.
 */
import {
  DecodingMode,
  EntityDecoder,
  fromCodePoint,
  htmlDecodeTree,
} from 'entities/lib/decode.js'

export enum ParseMode {
  BASE, // 基础解析方式
  HTML, // html解析方式，可以解析html标签和html实体
  SFC, // single file component  单文件组件格式 包括template、 script、 style三个部分内容
}

export enum CharCodes {
  Tab = 0x9, // "\t"
  NewLine = 0xa, // "\n"
  FormFeed = 0xc, // "\f"
  CarriageReturn = 0xd, // "\r"
  Space = 0x20, // " "
  ExclamationMark = 0x21, // "!"
  Number = 0x23, // "#"
  Amp = 0x26, // "&"
  SingleQuote = 0x27, // "'"
  DoubleQuote = 0x22, // '"'
  GraveAccent = 96, // "`"
  Dash = 0x2d, // "-"
  Slash = 0x2f, // "/"
  Zero = 0x30, // "0"
  Nine = 0x39, // "9"
  Semi = 0x3b, // ";"
  Lt = 0x3c, // "<"
  Eq = 0x3d, // "="
  Gt = 0x3e, // ">"
  Questionmark = 0x3f, // "?"
  UpperA = 0x41, // "A"
  LowerA = 0x61, // "a"
  UpperF = 0x46, // "F"
  LowerF = 0x66, // "f"
  UpperZ = 0x5a, // "Z"
  LowerZ = 0x7a, // "z"
  LowerX = 0x78, // "x"
  LowerV = 0x76, // "v"
  Dot = 0x2e, // "."
  Colon = 0x3a, // ":"
  At = 0x40, // "@"
  LeftSquare = 91, // "["
  RightSquare = 93, // "]"
}

const defaultDelimitersOpen = new Uint8Array([123, 123]) // "{{"
const defaultDelimitersClose = new Uint8Array([125, 125]) // "}}"

/** All the states the tokenizer can be in. */
// State 枚举用于描述状态机的不同状态
export enum State {
  Text = 1, // 普通文本的状态，当解析器处于此状态时，遇到的字符会被视为普通文本，并直接输出

  // interpolation 插值
  InterpolationOpen, // 进入插值表达式的启示状态。通常对应于{{
  Interpolation, // 插值表达式的内部状态，在这里解析器解析{{ 和 }}之间的表达式内容
  InterpolationClose, // 插值表达式的结束状态。通常对应于}} 的检测

  // Tags  标签解析
  BeforeTagName, // After < 表示在检测到<之后，准备开始解析标签名称的状态
  InTagName, // 正在解析标签名称的状态。例如，解析<div 中的div
  InSelfClosingTag, // 检测到自闭合标签时的状态，通常对应于 />
  BeforeClosingTagName,// 在解析结束标签之前的状态，通常是检测到</后
  InClosingTagName, // 结束标签名称的状态，比如</div  中的div
  AfterClosingTagName, // 结束标签名称解析完成后的状态

  // Attrs
  BeforeAttrName, // 准备解析属性名称的状态
  InAttrName, // 解析属性名称的状态
  InDirName, // 解析指令名称的状态 如v-bind
  InDirArg, // 解析指令参数的状态 v-bind:arg
  InDirDynamicArg, // 解析动态指令参数的状态 比如v-bind:[dynamicArg]
  InDirModifier, // 解析指令修饰符的撞他v-bind.sync
  AfterAttrName, // 解析完属性名的状态
  BeforeAttrValue, // 阿欢解析属性值状态
  InAttrValueDq, // " 解析双引号包裹的属性值状态
  InAttrValueSq, // ' 解析单引号包括的属性值状态
  InAttrValueNq, // 解析没有引号包裹的属性值状态

  // Declarations
  BeforeDeclaration, // ! 准备解析声明的状态，例如<!DOCTYPE
  InDeclaration, // 正在解析声明的状态

  // Processing instructions
  InProcessingInstruction, // ?  处理XML或类似文件中的处理指令状态 <?...?>

  // Comments & CDATA
  BeforeComment, // 转变进入注释解析状态 <!--
  CDATASequence, // 解析CDATA序列状态，通常是<![CDATA[
  InSpecialComment, // 处理特殊注释的状态，比如vue特有的注释
  InCommentLike, // 解析注释或者类似注释结构的状态

  // Special tags
  BeforeSpecialS, // Decide if we deal with `<script` or `<style` 特殊标签
  BeforeSpecialT, // Decide if we deal with `<title` or `<textarea` 特殊标签
  SpecialStartSequence,// 特殊标签开始的状态，例如<script>或者<style>之后
  InRCDATA,// 解析器在RCDATA，比如<textarea>或者<title>中的状态

  InEntity, // 解析HTML实体的状态

  InSFCRootTagName, // 在Vue单文件组件SFC解析时，检测根标签名称的状态
}

/**
 * HTML only allows ASCII alpha characters (a-z and A-Z) at the beginning of a
 * tag name.
 */
function isTagStartChar(c: number): boolean {
  return (
    (c >= CharCodes.LowerA && c <= CharCodes.LowerZ) ||
    (c >= CharCodes.UpperA && c <= CharCodes.UpperZ)
  )
}

export function isWhitespace(c: number): boolean {
  return (
    c === CharCodes.Space ||
    c === CharCodes.NewLine ||
    c === CharCodes.Tab ||
    c === CharCodes.FormFeed ||
    c === CharCodes.CarriageReturn
  )
}

function isEndOfTagSection(c: number): boolean {
  // 在inTagName标签内状态时，如果遇到/>或者>或者空格，表示标签名读取结束
  return c === CharCodes.Slash || c === CharCodes.Gt || isWhitespace(c)
}

export function toCharCodes(str: string): Uint8Array {
  const ret = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    ret[i] = str.charCodeAt(i)
  }
  return ret
}

export enum QuoteType {
  NoValue = 0,
  Unquoted = 1,
  Single = 2,
  Double = 3,
}

export interface Callbacks {
  ontext(start: number, endIndex: number): void
  ontextentity(char: string, start: number, endIndex: number): void

  oninterpolation(start: number, endIndex: number): void

  onopentagname(start: number, endIndex: number): void
  onopentagend(endIndex: number): void
  onselfclosingtag(endIndex: number): void
  onclosetag(start: number, endIndex: number): void

  onattribdata(start: number, endIndex: number): void
  onattribentity(char: string, start: number, end: number): void
  onattribend(quote: QuoteType, endIndex: number): void
  onattribname(start: number, endIndex: number): void
  onattribnameend(endIndex: number): void

  ondirname(start: number, endIndex: number): void
  ondirarg(start: number, endIndex: number): void
  ondirmodifier(start: number, endIndex: number): void

  oncomment(start: number, endIndex: number): void
  oncdata(start: number, endIndex: number): void

  onprocessinginstruction(start: number, endIndex: number): void
  // ondeclaration(start: number, endIndex: number): void
  onend(): void
  onerr(code: ErrorCodes, index: number): void
}

/**
 * Sequences used to match longer strings.
 *
 * We don't have `Script`, `Style`, or `Title` here. Instead, we re-use the *End
 * sequences with an increased offset.
 */
export const Sequences = {
  Cdata: new Uint8Array([0x43, 0x44, 0x41, 0x54, 0x41, 0x5b]), // CDATA[
  CdataEnd: new Uint8Array([0x5d, 0x5d, 0x3e]), // ]]>
  CommentEnd: new Uint8Array([0x2d, 0x2d, 0x3e]), // `-->`
  ScriptEnd: new Uint8Array([0x3c, 0x2f, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74]), // `</script`
  StyleEnd: new Uint8Array([0x3c, 0x2f, 0x73, 0x74, 0x79, 0x6c, 0x65]), // `</style`
  TitleEnd: new Uint8Array([0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65]), // `</title`
  TextareaEnd: new Uint8Array([
    0x3c, 0x2f, 116, 101, 120, 116, 97, 114, 101, 97,
  ]), // `</textarea
}

export default class Tokenizer {
  /** The current state the tokenizer is in. */
  public state = State.Text // 默认文本状态
  /** The read buffer. */
  private buffer = ''
  /** The beginning of the section that is currently being read. */
  public sectionStart = 0
  /** The index within the buffer that we are currently looking at. */
  private index = 0
  /** The start of the last entity. */
  private entityStart = 0
  /** Some behavior, eg. when decoding entities, is done while we are in another state. This keeps track of the other state type. */
  private baseState = State.Text
  /** For special parsing behavior inside of script and style tags. */
  public inRCDATA = false
  /** For disabling RCDATA tags handling */
  public inXML = false
  /** For disabling interpolation parsing in v-pre */
  public inVPre = false
  /** Record newline positions for fast line / column calculation */
  private newlines: number[] = []

  private readonly entityDecoder?: EntityDecoder

  public mode = ParseMode.BASE
  public get inSFCRoot() {
    return this.mode === ParseMode.SFC && this.stack.length === 0
  }

  constructor(
    private readonly stack: ElementNode[],
    private readonly cbs: Callbacks,
  ) {
    if (!__BROWSER__) {
      this.entityDecoder = new EntityDecoder(htmlDecodeTree, (cp, consumed) =>
        this.emitCodePoint(cp, consumed),
      )
    }
  }

  public reset(): void {
    this.state = State.Text
    this.mode = ParseMode.BASE
    this.buffer = ''
    this.sectionStart = 0
    this.index = 0
    this.baseState = State.Text
    this.inRCDATA = false
    this.currentSequence = undefined!
    this.newlines.length = 0
    this.delimiterOpen = defaultDelimitersOpen
    this.delimiterClose = defaultDelimitersClose
  }

  /**
   * Generate Position object with line / column information using recorded
   * newline positions. We know the index is always going to be an already
   * processed index, so all the newlines up to this index should have been
   * recorded.
   * 由index计算出是第几行几列
   */
  public getPos(index: number): Position {
    let line = 1
    let column = index + 1
    for (let i = this.newlines.length - 1; i >= 0; i--) {
      const newlineIndex = this.newlines[i]
      if (index > newlineIndex) {
        line = i + 2
        column = index - newlineIndex
        break
      }
    }
    return {
      column,
      line,
      offset: index,
    }
  }

  private peek() {
    return this.buffer.charCodeAt(this.index + 1)
  }

  private stateText(c: number): void {
    if (c === CharCodes.Lt) { // 遇到<进入标签名开始状态
      if (this.index > this.sectionStart) { // 将<之前的文本元素作为一个文本节点加入到当前父元素的children中
        this.cbs.ontext(this.sectionStart, this.index)
      }
      this.state = State.BeforeTagName // 开启标签开始状态
      this.sectionStart = this.index // sectionStart表示这部分内容开始的位置，用来截断一段文本、元素标签名
    } else if (!__BROWSER__ && c === CharCodes.Amp) { // 遇到&进入实体状态
      this.startEntity()
    } else if (!this.inVPre && c === this.delimiterOpen[0]) { // 遇到{{进入插值文本状态
      this.state = State.InterpolationOpen 
      this.delimiterIndex = 0
      this.stateInterpolationOpen(c)
    }
  }

  public delimiterOpen: Uint8Array = defaultDelimitersOpen
  public delimiterClose: Uint8Array = defaultDelimitersClose
  private delimiterIndex = -1

  private stateInterpolationOpen(c: number): void {
    if (c === this.delimiterOpen[this.delimiterIndex]) {
      if (this.delimiterIndex === this.delimiterOpen.length - 1) {
        const start = this.index + 1 - this.delimiterOpen.length
        if (start > this.sectionStart) {
          this.cbs.ontext(this.sectionStart, start)
        }
        this.state = State.Interpolation
        this.sectionStart = start
      } else {
        this.delimiterIndex++
      }
    } else if (this.inRCDATA) {
      this.state = State.InRCDATA
      this.stateInRCDATA(c)
    } else {
      this.state = State.Text
      this.stateText(c)
    }
  }

  private stateInterpolation(c: number): void {
    if (c === this.delimiterClose[0]) {
      this.state = State.InterpolationClose
      this.delimiterIndex = 0
      this.stateInterpolationClose(c)
    }
  }

  private stateInterpolationClose(c: number) {
    if (c === this.delimiterClose[this.delimiterIndex]) {
      if (this.delimiterIndex === this.delimiterClose.length - 1) {
        this.cbs.oninterpolation(this.sectionStart, this.index + 1)
        if (this.inRCDATA) {
          this.state = State.InRCDATA
        } else {
          this.state = State.Text
        }
        this.sectionStart = this.index + 1
      } else {
        this.delimiterIndex++
      }
    } else {
      this.state = State.Interpolation
      this.stateInterpolation(c)
    }
  }

  public currentSequence: Uint8Array = undefined!
  private sequenceIndex = 0
  private stateSpecialStartSequence(c: number): void {
    const isEnd = this.sequenceIndex === this.currentSequence.length
    const isMatch = isEnd
      ? // If we are at the end of the sequence, make sure the tag name has ended
        isEndOfTagSection(c)
      : // Otherwise, do a case-insensitive comparison
        (c | 0x20) === this.currentSequence[this.sequenceIndex]

    if (!isMatch) {
      this.inRCDATA = false
    } else if (!isEnd) {
      this.sequenceIndex++
      return
    }

    this.sequenceIndex = 0
    this.state = State.InTagName
    this.stateInTagName(c)
  }

  /** Look for an end tag. For <title> and <textarea>, also decode entities. */
  private stateInRCDATA(c: number): void {
    if (this.sequenceIndex === this.currentSequence.length) {
      if (c === CharCodes.Gt || isWhitespace(c)) {
        const endOfText = this.index - this.currentSequence.length

        if (this.sectionStart < endOfText) {
          // Spoof the index so that reported locations match up.
          const actualIndex = this.index
          this.index = endOfText
          this.cbs.ontext(this.sectionStart, endOfText)
          this.index = actualIndex
        }

        this.sectionStart = endOfText + 2 // Skip over the `</`
        this.stateInClosingTagName(c)
        this.inRCDATA = false
        return // We are done; skip the rest of the function.
      }

      this.sequenceIndex = 0
    }

    if ((c | 0x20) === this.currentSequence[this.sequenceIndex]) {
      this.sequenceIndex += 1
    } else if (this.sequenceIndex === 0) {
      if (
        this.currentSequence === Sequences.TitleEnd ||
        (this.currentSequence === Sequences.TextareaEnd && !this.inSFCRoot)
      ) {
        // We have to parse entities in <title> and <textarea> tags.
        if (!__BROWSER__ && c === CharCodes.Amp) {
          this.startEntity()
        } else if (c === this.delimiterOpen[0]) {
          // We also need to handle interpolation
          this.state = State.InterpolationOpen
          this.delimiterIndex = 0
          this.stateInterpolationOpen(c)
        }
      } else if (this.fastForwardTo(CharCodes.Lt)) {
        // Outside of <title> and <textarea> tags, we can fast-forward.
        this.sequenceIndex = 1
      }
    } else {
      // If we see a `<`, set the sequence index to 1; useful for eg. `<</script>`.
      this.sequenceIndex = Number(c === CharCodes.Lt)
    }
  }

  private stateCDATASequence(c: number): void {
    if (c === Sequences.Cdata[this.sequenceIndex]) {
      if (++this.sequenceIndex === Sequences.Cdata.length) {
        this.state = State.InCommentLike
        this.currentSequence = Sequences.CdataEnd
        this.sequenceIndex = 0
        this.sectionStart = this.index + 1
      }
    } else {
      this.sequenceIndex = 0
      this.state = State.InDeclaration
      this.stateInDeclaration(c) // Reconsume the character
    }
  }

  /**
   * When we wait for one specific character, we can speed things up
   * by skipping through the buffer until we find it.
   *
   * @returns Whether the character was found.
   */
  private fastForwardTo(c: number): boolean {
    while (++this.index < this.buffer.length) {
      const cc = this.buffer.charCodeAt(this.index)
      if (cc === CharCodes.NewLine) {
        this.newlines.push(this.index)
      }
      if (cc === c) {
        return true
      }
    }

    /*
     * We increment the index at the end of the `parse` loop,
     * so set it to `buffer.length - 1` here.
     *
     * TODO: Refactor `parse` to increment index before calling states.
     */
    this.index = this.buffer.length - 1

    return false
  }

  /**
   * Comments and CDATA end with `-->` and `]]>`.
   *
   * Their common qualities are:
   * - Their end sequences have a distinct character they start with.
   * - That character is then repeated, so we have to check multiple repeats.
   * - All characters but the start character of the sequence can be skipped.
   */
  private stateInCommentLike(c: number): void {
    if (c === this.currentSequence[this.sequenceIndex]) {
      if (++this.sequenceIndex === this.currentSequence.length) {
        if (this.currentSequence === Sequences.CdataEnd) {
          this.cbs.oncdata(this.sectionStart, this.index - 2)
        } else {
          this.cbs.oncomment(this.sectionStart, this.index - 2)
        }

        this.sequenceIndex = 0
        this.sectionStart = this.index + 1
        this.state = State.Text
      }
    } else if (this.sequenceIndex === 0) {
      // Fast-forward to the first character of the sequence
      if (this.fastForwardTo(this.currentSequence[0])) {
        this.sequenceIndex = 1
      }
    } else if (c !== this.currentSequence[this.sequenceIndex - 1]) {
      // Allow long sequences, eg. --->, ]]]>
      this.sequenceIndex = 0
    }
  }

  private startSpecial(sequence: Uint8Array, offset: number) {
    this.enterRCDATA(sequence, offset)
    this.state = State.SpecialStartSequence
  }

  public enterRCDATA(sequence: Uint8Array, offset: number) {
    this.inRCDATA = true
    this.currentSequence = sequence
    this.sequenceIndex = offset
  }

  private stateBeforeTagName(c: number): void {
    if (c === CharCodes.ExclamationMark) {// 如果是<!开头的
      this.state = State.BeforeDeclaration // 进入解析声明状态
      this.sectionStart = this.index + 1 // sectionStart标志位下个字符索引
    } else if (c === CharCodes.Questionmark) { // 如果是<?开头的，进入xml解析状态
      this.state = State.InProcessingInstruction
      this.sectionStart = this.index + 1
    } else if (isTagStartChar(c)) { // 如果是字母a-zA-Z，说明是标签名开始解析状态，比如<div
      this.sectionStart = this.index // sectionStart调整为当前索引值，用来截取整个标签名
      if (this.mode === ParseMode.BASE) {
        // no special tags in base mode
        this.state = State.InTagName // 进入在标签中的状态
      } else if (this.inSFCRoot) {
        // SFC mode + root level
        // - everything except <template> is RAWTEXT
        // - <template> with lang other than html is also RAWTEXT
        this.state = State.InSFCRootTagName
      } else if (!this.inXML) {
        /**
         * 在解析 HTML 文档时，浏览器使用一种称为“状态机”的机制来读取和处理不同的标签和内容。在这个过程中，有两种特别的状态，分别是 RAWTEXT 和 RCDATA，它们用于处理 HTML 中不同类型的内容。
         * 这两种状态的主要区别在于它们如何处理内容中的字符数据，特别是 HTML 实体。
         */
        // HTML mode
        // - <script>, <style> RAWTEXT
        /**
         * 在 RAWTEXT 状态下，浏览器会将所有的文本内容都原封不动地当作纯文本进行解析，而不会尝试解析其中的任何 HTML 实体（如 &amp;）。
         * 在 RAWTEXT 状态中，浏览器不会认为文本内容中出现的 < 符号是标签的开始，而只是纯文本的一部分，直到遇到对应的结束标签。
         */
        // - <title>, <textarea> RCDATA
        /**
         * 在 RCDATA 状态下，浏览器会对内容中的字符数据进行解析，但只会解析 HTML 实体。例如，&amp; 会被解析为 &。
         * 类似于 RAWTEXT，在 RCDATA 状态下，文本内容中的 < 符号也不会被当作标签的开始，而是作为文本的一部分，直到遇到对应的结束标签。
         */
        // 将字符c转为小写形式
        const lower = c | 0x20
        if (lower === 116 /* t */) { // 如果是t，<title>, <textarea>，进入RCDATA解析状态，也就是里面的标签不解析，文本原样输出
          this.state = State.BeforeSpecialT
        } else { // 如果是s，，<script>、<style>，进入RAWTEXT解析状态
          this.state = lower === 115 /* s */ ? State.BeforeSpecialS : State.InTagName
        }
      } else {
        this.state = State.InTagName
      }
    } else if (c === CharCodes.Slash) { // 如果是</开头，进入结标签名状态
      this.state = State.BeforeClosingTagName
    } else { // 其它无法识别的都是作为文本处理
      this.state = State.Text
      this.stateText(c)
    }
  }
  private stateInTagName(c: number): void {
    // 比如<div> <img/>  <div class=...标签标inTagName状态结束，需要处理标签元素
    if (isEndOfTagSection(c)) {
      this.handleTagName(c)
    }
  }
  private stateInSFCRootTagName(c: number): void {
    if (isEndOfTagSection(c)) {
      const tag = this.buffer.slice(this.sectionStart, this.index)
      if (tag !== 'template') {
        this.enterRCDATA(toCharCodes(`</` + tag), 0)
      }
      this.handleTagName(c)
    }
  }
  private handleTagName(c: number) {
    // 获取了当前currentOpenTag，创建了tag对应的元素节点
    this.cbs.onopentagname(this.sectionStart, this.index)
    this.sectionStart = -1
    this.state = State.BeforeAttrName // 进入属性名开始解析状态
    this.stateBeforeAttrName(c)
  }

  // 进入标签名结束解析状态，比如</div>
  private stateBeforeClosingTagName(c: number): void {
    if (isWhitespace(c)) { // 空格什么都不做
      // Ignore
    } else if (c === CharCodes.Gt) { // 遇到>符号，说明标签名结束解析状态结束，又重新进入文本状态
      if (__DEV__ || !__BROWSER__) {
        this.cbs.onerr(ErrorCodes.MISSING_END_TAG_NAME, this.index)
      }
      this.state = State.Text
      // Ignore
      this.sectionStart = this.index + 1
    } else {
      // 结束标签名解析状态进入
      this.state = isTagStartChar(c) // 是否是大小写字母
        ? State.InClosingTagName // inClosingTagName状态
        : State.InSpecialComment
      this.sectionStart = this.index
    }
  }
  // 结束标签名称的状态
  private stateInClosingTagName(c: number): void {
    if (c === CharCodes.Gt || isWhitespace(c)) { // 遇到>获取空格，表示结束标签名称解析完毕
      this.cbs.onclosetag(this.sectionStart, this.index) // sectionStart是用来存储一个片段的起始位置，比如开始标签名、结束标签名、一段文本
      this.sectionStart = -1
      this.state = State.AfterClosingTagName // 关闭标签结束状态
      this.stateAfterClosingTagName(c)
    }
  }
  private stateAfterClosingTagName(c: number): void {
    // Skip everything until ">"
    if (c === CharCodes.Gt) {// 关闭标签名称解析结束，进入文本状态
      this.state = State.Text
      this.sectionStart = this.index + 1
    }
  }
  private stateBeforeAttrName(c: number): void {
    if (c === CharCodes.Gt) { // 如果是>，比如<div>，表示标签名open状态解析结束，没有属性
      this.cbs.onopentagend(this.index)
      // 开始标签名解析结束后，进入InRCDATA状态或文本状态
      if (this.inRCDATA) {
        this.state = State.InRCDATA
      } else {
        this.state = State.Text
      }
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.Slash) {// 如果是遇到/ 说明是<img/>这样的场景，说明是半闭合元素
      this.state = State.InSelfClosingTag
      if ((__DEV__ || !__BROWSER__) && this.peek() !== CharCodes.Gt) {
        // 如是开发环境，/后面不是>符号就报错，说明语法不正确
        this.cbs.onerr(ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG, this.index)
      }
    } else if (c === CharCodes.Lt && this.peek() === CharCodes.Slash) {
      // special handling for </ appearing in open tag state
      // this is different from standard HTML parsing but makes practical sense
      // especially for parsing intermediate input state in IDEs.
      /**
       * 在 Vue 3 的解析过程中，为了兼容开发者在使用 IDE（集成开发环境）时的中间输入状态，Vue 做了一些不同于标准 HTML 解析的处理。比如，当开发者在 IDE 中输入不完整的代码时，
       * 可能会出现诸如 </ 这样的未完成语句，这时的代码是处于编辑状态，还未形成完整的 HTML 结构。
       */
      this.cbs.onopentagend(this.index)
      this.state = State.BeforeTagName
      this.sectionStart = this.index
    } else if (!isWhitespace(c)) {
      if ((__DEV__ || !__BROWSER__) && c === CharCodes.Eq) {
        this.cbs.onerr(
          ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME,
          this.index,
        )
      }
      this.handleAttrStart(c)
    }
  }

  // 解析属性开始的状态
  private handleAttrStart(c: number) {
    // v-if/v-for
    if (c === CharCodes.LowerV && this.peek() === CharCodes.Dash) { // v-开头 表示进入指令状态
      this.state = State.InDirName // 指令名称解析状态
      this.sectionStart = this.index
    } else if (
      c === CharCodes.Dot || // . : @ #
      c === CharCodes.Colon ||
      c === CharCodes.At ||
      c === CharCodes.Number
    ) {
      this.cbs.ondirname(this.index, this.index + 1)
      this.state = State.InDirArg
      this.sectionStart = this.index + 1
    } else {
      this.state = State.InAttrName
      this.sectionStart = this.index
    }
  }
  private stateInSelfClosingTag(c: number): void {
    if (c === CharCodes.Gt) {
      this.cbs.onselfclosingtag(this.index)
      this.state = State.Text
      this.sectionStart = this.index + 1
      this.inRCDATA = false // Reset special state, in case of self-closing special tags
    } else if (!isWhitespace(c)) {
      this.state = State.BeforeAttrName
      this.stateBeforeAttrName(c)
    }
  }
  private stateInAttrName(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      this.cbs.onattribname(this.sectionStart, this.index)
      this.handleAttrNameEnd(c)
    } else if (
      (__DEV__ || !__BROWSER__) &&
      (c === CharCodes.DoubleQuote ||
        c === CharCodes.SingleQuote ||
        c === CharCodes.Lt)
    ) {
      this.cbs.onerr(
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        this.index,
      )
    }
  }
  private stateInDirName(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) { // 遇到=或者/>或者空格，表示指令名称解析结束
      this.cbs.ondirname(this.sectionStart, this.index)
      this.handleAttrNameEnd(c)
    } else if (c === CharCodes.Colon) { // 遇到：表示进入指令参数解析状态
      this.cbs.ondirname(this.sectionStart, this.index)
      this.state = State.InDirArg
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.Dot) { // 遇到.，指令修复符解析，比如v-bind.sync
      this.cbs.ondirname(this.sectionStart, this.index)
      this.state = State.InDirModifier
      this.sectionStart = this.index + 1
    }
  }
  private stateInDirArg(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      this.cbs.ondirarg(this.sectionStart, this.index)
      this.handleAttrNameEnd(c)
    } else if (c === CharCodes.LeftSquare) {
      this.state = State.InDirDynamicArg
    } else if (c === CharCodes.Dot) {
      this.cbs.ondirarg(this.sectionStart, this.index)
      this.state = State.InDirModifier
      this.sectionStart = this.index + 1
    }
  }
  private stateInDynamicDirArg(c: number): void {
    if (c === CharCodes.RightSquare) {
      this.state = State.InDirArg
    } else if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      this.cbs.ondirarg(this.sectionStart, this.index + 1)
      this.handleAttrNameEnd(c)
      if (__DEV__ || !__BROWSER__) {
        this.cbs.onerr(
          ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END,
          this.index,
        )
      }
    }
  }
  private stateInDirModifier(c: number): void {
    if (c === CharCodes.Eq || isEndOfTagSection(c)) {
      this.cbs.ondirmodifier(this.sectionStart, this.index)
      this.handleAttrNameEnd(c)
    } else if (c === CharCodes.Dot) {
      this.cbs.ondirmodifier(this.sectionStart, this.index)
      this.sectionStart = this.index + 1
    }
  }
  private handleAttrNameEnd(c: number): void {
    this.sectionStart = this.index
    this.state = State.AfterAttrName // 进入属性名称解析结束状态，
    this.cbs.onattribnameend(this.index)
    this.stateAfterAttrName(c) // 属性名称解析结束后，解析属性值
  }
  private stateAfterAttrName(c: number): void {
    if (c === CharCodes.Eq) { // 遇到等于号，比如v-for="xxx"，进入属性值解析
      this.state = State.BeforeAttrValue
    } else if (c === CharCodes.Slash || c === CharCodes.Gt) {
      this.cbs.onattribend(QuoteType.NoValue, this.sectionStart)
      this.sectionStart = -1
      this.state = State.BeforeAttrName
      this.stateBeforeAttrName(c)
    } else if (!isWhitespace(c)) {
      this.cbs.onattribend(QuoteType.NoValue, this.sectionStart)
      this.handleAttrStart(c)
    }
  }

  // 属性值解析
  private stateBeforeAttrValue(c: number): void {
    if (c === CharCodes.DoubleQuote) { // 双引号"
      this.state = State.InAttrValueDq //双引号属性值
      this.sectionStart = this.index + 1
    } else if (c === CharCodes.SingleQuote) { // 单引号'
      this.state = State.InAttrValueSq //单引号属性值
      this.sectionStart = this.index + 1
    } else if (!isWhitespace(c)) { // 其它不是空格情况，就是没有引号包裹的属性值，比如width=100
      this.sectionStart = this.index
      this.state = State.InAttrValueNq 
      this.stateInAttrValueNoQuotes(c) // Reconsume token
    }
  }
  private handleInAttrValue(c: number, quote: number) {
    if (c === quote || (__BROWSER__ && this.fastForwardTo(quote))) {
      this.cbs.onattribdata(this.sectionStart, this.index)
      this.sectionStart = -1
      this.cbs.onattribend(
        quote === CharCodes.DoubleQuote ? QuoteType.Double : QuoteType.Single,
        this.index + 1,
      )
      this.state = State.BeforeAttrName // 属性值解析过后，再次进入属性名的解析
    } else if (!__BROWSER__ && c === CharCodes.Amp) { // 实体解析
      this.startEntity()
    }
  }
  // 双引号属性值解析
  private stateInAttrValueDoubleQuotes(c: number): void {
    this.handleInAttrValue(c, CharCodes.DoubleQuote)
  }
  // 单引号属性值解析
  private stateInAttrValueSingleQuotes(c: number): void {
    this.handleInAttrValue(c, CharCodes.SingleQuote)
  }
  private stateInAttrValueNoQuotes(c: number): void {
    if (isWhitespace(c) || c === CharCodes.Gt) {
      this.cbs.onattribdata(this.sectionStart, this.index)
      this.sectionStart = -1
      this.cbs.onattribend(QuoteType.Unquoted, this.index)
      this.state = State.BeforeAttrName
      this.stateBeforeAttrName(c)
    } else if (
      ((__DEV__ || !__BROWSER__) && c === CharCodes.DoubleQuote) ||
      c === CharCodes.SingleQuote ||
      c === CharCodes.Lt ||
      c === CharCodes.Eq ||
      c === CharCodes.GraveAccent
    ) {
      this.cbs.onerr(
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        this.index,
      )
    } else if (!__BROWSER__ && c === CharCodes.Amp) {
      this.startEntity()
    }
  }
  private stateBeforeDeclaration(c: number): void {
    if (c === CharCodes.LeftSquare) {
      this.state = State.CDATASequence
      this.sequenceIndex = 0
    } else {
      this.state =
        c === CharCodes.Dash ? State.BeforeComment : State.InDeclaration
    }
  }
  private stateInDeclaration(c: number): void {
    if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
      // this.cbs.ondeclaration(this.sectionStart, this.index)
      this.state = State.Text
      this.sectionStart = this.index + 1
    }
  }
  private stateInProcessingInstruction(c: number): void {
    if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
      this.cbs.onprocessinginstruction(this.sectionStart, this.index)
      this.state = State.Text
      this.sectionStart = this.index + 1
    }
  }
  private stateBeforeComment(c: number): void {
    if (c === CharCodes.Dash) {
      this.state = State.InCommentLike
      this.currentSequence = Sequences.CommentEnd
      // Allow short comments (eg. <!-->)
      this.sequenceIndex = 2
      this.sectionStart = this.index + 1
    } else {
      this.state = State.InDeclaration
    }
  }
  private stateInSpecialComment(c: number): void {
    if (c === CharCodes.Gt || this.fastForwardTo(CharCodes.Gt)) {
      this.cbs.oncomment(this.sectionStart, this.index)
      this.state = State.Text
      this.sectionStart = this.index + 1
    }
  }
  private stateBeforeSpecialS(c: number): void {
    const lower = c | 0x20
    if (lower === Sequences.ScriptEnd[3]) {
      this.startSpecial(Sequences.ScriptEnd, 4)
    } else if (lower === Sequences.StyleEnd[3]) {
      this.startSpecial(Sequences.StyleEnd, 4)
    } else {
      this.state = State.InTagName
      this.stateInTagName(c) // Consume the token again
    }
  }
  private stateBeforeSpecialT(c: number): void {
    const lower = c | 0x20
    if (lower === Sequences.TitleEnd[3]) {
      this.startSpecial(Sequences.TitleEnd, 4)
    } else if (lower === Sequences.TextareaEnd[3]) {
      this.startSpecial(Sequences.TextareaEnd, 4)
    } else {
      this.state = State.InTagName
      this.stateInTagName(c) // Consume the token again
    }
  }

  private startEntity() {
    if (!__BROWSER__) {
      this.baseState = this.state
      this.state = State.InEntity
      this.entityStart = this.index
      this.entityDecoder!.startEntity(
        this.baseState === State.Text || this.baseState === State.InRCDATA
          ? DecodingMode.Legacy
          : DecodingMode.Attribute,
      )
    }
  }

  private stateInEntity(): void {
    if (!__BROWSER__) {
      const length = this.entityDecoder!.write(this.buffer, this.index)

      // If `length` is positive, we are done with the entity.
      if (length >= 0) {
        this.state = this.baseState

        if (length === 0) {
          this.index = this.entityStart
        }
      } else {
        // Mark buffer as consumed.
        this.index = this.buffer.length - 1
      }
    }
  }

  /**
   * Iterates through the buffer, calling the function corresponding to the current state.
   *
   * States that are more likely to be hit are higher up, as a performance improvement.
   * 解析模板
   */
  public parse(input: string) {
    this.buffer = input
    while (this.index < this.buffer.length) {
      const c = this.buffer.charCodeAt(this.index)
      if (c === CharCodes.NewLine) {
        this.newlines.push(this.index) // 用来计算loc，就是每个元素第几行几列，方便出错时bug跟踪
      }
      switch (this.state) {
        case State.Text: {
          this.stateText(c)
          break
        }
        case State.InterpolationOpen: {
          this.stateInterpolationOpen(c)
          break
        }
        case State.Interpolation: {
          this.stateInterpolation(c)
          break
        }
        case State.InterpolationClose: {
          this.stateInterpolationClose(c)
          break
        }
        case State.SpecialStartSequence: {
          this.stateSpecialStartSequence(c)
          break
        }
        case State.InRCDATA: {
          this.stateInRCDATA(c)
          break
        }
        case State.CDATASequence: {
          this.stateCDATASequence(c)
          break
        }
        case State.InAttrValueDq: {
          this.stateInAttrValueDoubleQuotes(c)
          break
        }
        case State.InAttrName: {
          this.stateInAttrName(c)
          break
        }
        case State.InDirName: {
          this.stateInDirName(c)
          break
        }
        case State.InDirArg: {
          this.stateInDirArg(c)
          break
        }
        case State.InDirDynamicArg: {
          this.stateInDynamicDirArg(c)
          break
        }
        case State.InDirModifier: {
          this.stateInDirModifier(c)
          break
        }
        case State.InCommentLike: {
          this.stateInCommentLike(c)
          break
        }
        case State.InSpecialComment: {
          this.stateInSpecialComment(c)
          break
        }
        case State.BeforeAttrName: {
          this.stateBeforeAttrName(c)
          break
        }
        case State.InTagName: {
          this.stateInTagName(c)
          break
        }
        case State.InSFCRootTagName: {
          this.stateInSFCRootTagName(c)
          break
        }
        case State.InClosingTagName: {
          this.stateInClosingTagName(c)
          break
        }
        case State.BeforeTagName: {
          this.stateBeforeTagName(c)
          break
        }
        case State.AfterAttrName: {
          this.stateAfterAttrName(c)
          break
        }
        case State.InAttrValueSq: {
          this.stateInAttrValueSingleQuotes(c)
          break
        }
        case State.BeforeAttrValue: {
          this.stateBeforeAttrValue(c)
          break
        }
        case State.BeforeClosingTagName: {
          this.stateBeforeClosingTagName(c)
          break
        }
        case State.AfterClosingTagName: {
          this.stateAfterClosingTagName(c)
          break
        }
        case State.BeforeSpecialS: {
          this.stateBeforeSpecialS(c)
          break
        }
        case State.BeforeSpecialT: {
          this.stateBeforeSpecialT(c)
          break
        }
        case State.InAttrValueNq: {
          this.stateInAttrValueNoQuotes(c)
          break
        }
        case State.InSelfClosingTag: {
          this.stateInSelfClosingTag(c)
          break
        }
        case State.InDeclaration: {
          this.stateInDeclaration(c)
          break
        }
        case State.BeforeDeclaration: {
          this.stateBeforeDeclaration(c)
          break
        }
        case State.BeforeComment: {
          this.stateBeforeComment(c)
          break
        }
        case State.InProcessingInstruction: {
          this.stateInProcessingInstruction(c)
          break
        }
        case State.InEntity: {
          this.stateInEntity()
          break
        }
      }
      this.index++
    }
    this.cleanup()
    this.finish()
  }

  /**
   * Remove data that has already been consumed from the buffer.
   */
  private cleanup() {
    // If we are inside of text or attributes, emit what we already have.
    if (this.sectionStart !== this.index) {
      if (
        this.state === State.Text ||
        (this.state === State.InRCDATA && this.sequenceIndex === 0)
      ) {
        this.cbs.ontext(this.sectionStart, this.index)
        this.sectionStart = this.index
      } else if (
        this.state === State.InAttrValueDq ||
        this.state === State.InAttrValueSq ||
        this.state === State.InAttrValueNq
      ) {
        this.cbs.onattribdata(this.sectionStart, this.index)
        this.sectionStart = this.index
      }
    }
  }

  private finish() {
    if (!__BROWSER__ && this.state === State.InEntity) {
      this.entityDecoder!.end()
      this.state = this.baseState
    }

    this.handleTrailingData()

    this.cbs.onend()
  }

  /** Handle any trailing data. */
  private handleTrailingData() {
    const endIndex = this.buffer.length

    // If there is no remaining data, we are done.
    if (this.sectionStart >= endIndex) {
      return
    }

    if (this.state === State.InCommentLike) {
      if (this.currentSequence === Sequences.CdataEnd) {
        this.cbs.oncdata(this.sectionStart, endIndex)
      } else {
        this.cbs.oncomment(this.sectionStart, endIndex)
      }
    } else if (
      this.state === State.InTagName ||
      this.state === State.BeforeAttrName ||
      this.state === State.BeforeAttrValue ||
      this.state === State.AfterAttrName ||
      this.state === State.InAttrName ||
      this.state === State.InDirName ||
      this.state === State.InDirArg ||
      this.state === State.InDirDynamicArg ||
      this.state === State.InDirModifier ||
      this.state === State.InAttrValueSq ||
      this.state === State.InAttrValueDq ||
      this.state === State.InAttrValueNq ||
      this.state === State.InClosingTagName
    ) {
      /*
       * If we are currently in an opening or closing tag, us not calling the
       * respective callback signals that the tag should be ignored.
       */
    } else {
      this.cbs.ontext(this.sectionStart, endIndex)
    }
  }

  private emitCodePoint(cp: number, consumed: number): void {
    if (!__BROWSER__) {
      if (this.baseState !== State.Text && this.baseState !== State.InRCDATA) {
        if (this.sectionStart < this.entityStart) {
          this.cbs.onattribdata(this.sectionStart, this.entityStart)
        }
        this.sectionStart = this.entityStart + consumed
        this.index = this.sectionStart - 1

        this.cbs.onattribentity(
          fromCodePoint(cp),
          this.entityStart,
          this.sectionStart,
        )
      } else {
        if (this.sectionStart < this.entityStart) {
          this.cbs.ontext(this.sectionStart, this.entityStart)
        }
        this.sectionStart = this.entityStart + consumed
        this.index = this.sectionStart - 1

        this.cbs.ontextentity(
          fromCodePoint(cp),
          this.entityStart,
          this.sectionStart,
        )
      }
    }
  }
}
