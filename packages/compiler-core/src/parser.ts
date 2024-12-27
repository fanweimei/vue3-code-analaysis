import {
  type AttributeNode,
  ConstantTypes,
  type DirectiveNode,
  type ElementNode,
  ElementTypes,
  type ForParseResult,
  Namespaces,
  NodeTypes,
  type RootNode,
  type SimpleExpressionNode,
  type SourceLocation,
  type TemplateChildNode,
  createRoot,
  createSimpleExpression,
} from './ast'
import type { ParserOptions } from './options'
import Tokenizer, {
  CharCodes,
  ParseMode,
  QuoteType,
  Sequences,
  State,
  isWhitespace,
  toCharCodes,
} from './tokenizer'
import {
  type CompilerCompatOptions,
  CompilerDeprecationTypes,
  checkCompatEnabled,
  isCompatEnabled,
  warnDeprecation,
} from './compat/compatConfig'
import { NO, extend } from '@vue/shared'
import {
  ErrorCodes,
  createCompilerError,
  defaultOnError,
  defaultOnWarn,
} from './errors'
import {
  forAliasRE,
  isCoreComponent,
  isSimpleIdentifier,
  isStaticArgOf,
} from './utils'
import { decodeHTML } from 'entities/lib/decode.js'
import {
  type ParserOptions as BabelOptions,
  parse,
  parseExpression,
} from '@babel/parser'

type OptionalOptions =
  | 'decodeEntities'
  | 'whitespace'
  | 'isNativeTag'
  | 'isBuiltInComponent'
  | 'expressionPlugins'
  | keyof CompilerCompatOptions

export type MergedParserOptions = Omit<
  Required<ParserOptions>,
  OptionalOptions
> &
  Pick<ParserOptions, OptionalOptions>

export const defaultParserOptions: MergedParserOptions = {
  parseMode: 'base',
  ns: Namespaces.HTML,
  delimiters: [`{{`, `}}`],
  getNamespace: () => Namespaces.HTML,
  isVoidTag: NO,
  isPreTag: NO,
  isCustomElement: NO,
  onError: defaultOnError,
  onWarn: defaultOnWarn,
  comments: __DEV__,
  prefixIdentifiers: false,
}

let currentOptions: MergedParserOptions = defaultParserOptions
let currentRoot: RootNode | null = null

// parser state
let currentInput = ''
let currentOpenTag: ElementNode | null = null
let currentProp: AttributeNode | DirectiveNode | null = null
let currentAttrValue = ''
let currentAttrStartIndex = -1
let currentAttrEndIndex = -1
let inPre = 0
let inVPre = false
let currentVPreBoundary: ElementNode | null = null
// 父元素栈，栈中的第一个元素当前的父元素
const stack: ElementNode[] = []

// 通过状态机的工作原理、模板编译器，将模板字符串切割为一个个 Token，通过token构建一颗AST抽象语法树
// stack是栈
const tokenizer = new Tokenizer(stack, {
  onerr: emitError,

  // 具体处理文本元素节点
  ontext(start, end) {
    onText(getSlice(start, end), start, end)
  },
  // 实体处理
  ontextentity(char, start, end) {
    onText(char, start, end)
  },

  //插值处理
  oninterpolation(start, end) {
    if (inVPre) {
      return onText(getSlice(start, end), start, end)
    }
    let innerStart = start + tokenizer.delimiterOpen.length // {{后面的第一个字符
    let innerEnd = end - tokenizer.delimiterClose.length //}}前面的最后一个支付
    while (isWhitespace(currentInput.charCodeAt(innerStart))) { //去掉两边的空白
      innerStart++
    }
    while (isWhitespace(currentInput.charCodeAt(innerEnd - 1))) {
      innerEnd--
    }
    let exp = getSlice(innerStart, innerEnd)
    // decode entities for backwards compat 插值中如果有&，依然要处理实体
    if (exp.includes('&')) {
      if (__BROWSER__) {
        exp = currentOptions.decodeEntities!(exp, false)
      } else {
        exp = decodeHTML(exp)
      }
    }
    //创建一个插值节点，内容就是插值的表达式，结构跟文本节点类似，只是type是INTERPOLATION
    addNode({
      type: NodeTypes.INTERPOLATION,
      content: createExp(exp, false, getLoc(innerStart, innerEnd)),
      loc: getLoc(start, end),
    })
  },

  // 获取开始标签元素节点
  onopentagname(start, end) {
    const name = getSlice(start, end)
    /**
     * loc 属性用于表示 AST（抽象语法树）节点在源代码中的位置信息，帮助开发者在编译阶段更好地追踪和调试代码。
     * 具体来说，loc 包含了节点在模板中的起始和结束位置，以及相关的位置信息，这对于错误报告、代码映射、和源代码生成非常重要
     * start：节点在源代码中的起始位置（即标签开始的位置）。
      end：节点在源代码中的结束位置（即标签结束的位置）。
      source：节点对应的源代码片段（可以是字符串）。
     */
    currentOpenTag = {
      type: NodeTypes.ELEMENT, // 元素节点
      tag: name, // 标签名
      ns: currentOptions.getNamespace(name, stack[0], currentOptions.ns),
      tagType: ElementTypes.ELEMENT, // will be refined on tag close
      props: [],
      children: [],
      loc: getLoc(start - 1, end),
      codegenNode: undefined,
    }
  },

  // 标签名开始状态解析关闭 比如<div>
  onopentagend(end) {
    endOpenTag(end)
  },

  // 结束标签名获取
  onclosetag(start, end) {
    const name = getSlice(start, end)
    if (!currentOptions.isVoidTag(name)) {
      let found = false
      for (let i = 0; i < stack.length; i++) {
        // 
        const e = stack[i]
        if (e.tag.toLowerCase() === name.toLowerCase()) {
          found = true
          /**
           * 给了一个容错率，理论上应该是匹配stack栈中第一个元素标签，才是正确的，如果不是匹配第一个元素，给出错误提示
           * 比如<div><div><span></div></span></div>
           * 在遇到第一个</div>的时候，匹配的是栈中的第二个元素 
           */
          if (i > 0) {
            emitError(ErrorCodes.X_MISSING_END_TAG, stack[0].loc.start.offset)
          }
          for (let j = 0; j <= i; j++) {
            const el = stack.shift()!
            onCloseTag(el, end, j < i) // 重新更新元素的loc位置信息
          }
          break
        }
      }
      /**
       * 如果从stack栈中没有找到对应的元素，说明语法是由错误的，比如<div>hello</span></div> 解析到span结束标签的时候栈中没有与之匹配的，就报错
       */
      if (!found) {
        emitError(ErrorCodes.X_INVALID_END_TAG, backTrack(start, CharCodes.Lt))
      }
    }
  },

  onselfclosingtag(end) {
    const name = currentOpenTag!.tag
    currentOpenTag!.isSelfClosing = true
    endOpenTag(end)
    if (stack[0]?.tag === name) {
      onCloseTag(stack.shift()!, end)
    }
  },

  // 普通属性节点
  onattribname(start, end) {
    // plain attribute
    currentProp = {
      type: NodeTypes.ATTRIBUTE,
      name: getSlice(start, end),
      nameLoc: getLoc(start, end),
      value: undefined,
      loc: getLoc(start),
    }
  },

  // 解析指令名称
  ondirname(start, end) {
    const raw = getSlice(start, end)
    const name =
      raw === '.' || raw === ':' // .或者：开头说明是绑定变量，比如:name="xx" ，：其实就是v-bind的简写
        ? 'bind'
        : raw === '@' // @开头，说明是事件绑定，比如@click @符号是v-on的简写
          ? 'on'
          : raw === '#' // #开头，说明是插槽，比如:#slot #是v-slot的简写
            ? 'slot'
            : raw.slice(2) // 否则就是其它指令，vue默认指令格式v-开头，所以截取两个字符

    if (!inVPre && name === '') {
      emitError(ErrorCodes.X_MISSING_DIRECTIVE_NAME, start)
    }

    if (inVPre || name === '') {
      currentProp = {
        type: NodeTypes.ATTRIBUTE,
        name: raw,
        nameLoc: getLoc(start, end),
        value: undefined,
        loc: getLoc(start),
      }
    } else {
      currentProp = { // 创建一个指令 prop
        type: NodeTypes.DIRECTIVE,
        name, // 比如v-for
        rawName: raw, // 比如for
        exp: undefined,
        arg: undefined,
        modifiers: raw === '.' ? ['prop'] : [],
        loc: getLoc(start),
      }
      if (name === 'pre') {
        inVPre = tokenizer.inVPre = true
        currentVPreBoundary = currentOpenTag
        // convert dirs before this one to attributes
        const props = currentOpenTag!.props
        for (let i = 0; i < props.length; i++) {
          if (props[i].type === NodeTypes.DIRECTIVE) {
            props[i] = dirToAttr(props[i] as DirectiveNode)
          }
        }
      }
    }
  },

  // 指令参数解析，比如v-bind:id，解析出id值
  ondirarg(start, end) {
    if (start === end) return
    const arg = getSlice(start, end)
    if (inVPre) {
      ;(currentProp as AttributeNode).name += arg
      setLocEnd((currentProp as AttributeNode).nameLoc, end)
    } else {
      const isStatic = arg[0] !== `[` //如果是[开头说明是动态的
      ;(currentProp as DirectiveNode).arg = createExp( // 更新当前指令属性比如v-bind的arg，创建一个表达式
        isStatic ? arg : arg.slice(1, -1),
        isStatic,
        getLoc(start, end),
        isStatic ? ConstantTypes.CAN_STRINGIFY : ConstantTypes.NOT_CONSTANT,
      )
    }
  },

  ondirmodifier(start, end) {
    const mod = getSlice(start, end)
    if (inVPre) {
      ;(currentProp as AttributeNode).name += '.' + mod
      setLocEnd((currentProp as AttributeNode).nameLoc, end)
    } else if ((currentProp as DirectiveNode).name === 'slot') {
      // slot has no modifiers, special case for edge cases like
      // https://github.com/vuejs/language-tools/issues/2710
      const arg = (currentProp as DirectiveNode).arg
      if (arg) {
        ;(arg as SimpleExpressionNode).content += '.' + mod
        setLocEnd(arg.loc, end)
      }
    } else {
      ;(currentProp as DirectiveNode).modifiers.push(mod)
    }
  },

  // 记录当前属性节点的属性值
  onattribdata(start, end) {
    currentAttrValue += getSlice(start, end)
    // 属性值开始位置和结束位置，用来计算prop的位置，每次计算一个currentProp的时候，都会重置为-1
    if (currentAttrStartIndex < 0) currentAttrStartIndex = start
    currentAttrEndIndex = end
  },

  onattribentity(char, start, end) {
    currentAttrValue += char
    if (currentAttrStartIndex < 0) currentAttrStartIndex = start
    currentAttrEndIndex = end
  },

  // 属性名状态解析结束
  onattribnameend(end) {
    const start = currentProp!.loc.start.offset
    const name = getSlice(start, end)
    if (currentProp!.type === NodeTypes.DIRECTIVE) { 
      currentProp!.rawName = name
    }
    // check duplicate attrs
    if (
      currentOpenTag!.props.some( // 判断当前解析的标签元素中的props是否已经存在同样的指令，是就报错
        p => (p.type === NodeTypes.DIRECTIVE ? p.rawName : p.name) === name,
      )
    ) {
      emitError(ErrorCodes.DUPLICATE_ATTRIBUTE, start)
    }
  },
  // 属性结束处理，属性名和属性值都读取完毕
  onattribend(quote, end) {
    if (currentOpenTag && currentProp) {
      // finalize end pos 完善整个prop的路径，比如完整的，应该是v-for="branch in branches"
      setLocEnd(currentProp.loc, end)

      if (quote !== QuoteType.NoValue) { // 没有引号的可能是boolean或者number类型，如果是字符串类型肯定是有引号的，所以需要处理实体（属性值里面需要处理实体）
        if (__BROWSER__ && currentAttrValue.includes('&')) { // 如果属性值中包含实体，处理实体
          currentAttrValue = currentOptions.decodeEntities!(
            currentAttrValue,
            true,
          )
        }

        if (currentProp.type === NodeTypes.ATTRIBUTE) { // 普通属性的处理
          // assign value 处理属性

          // condense whitespaces in class
          // 处理class，class可能会有多个样式类，书写的时候会有多余空白，去掉多余空白，让样式类之间只有一个空白符
          if (currentProp!.name === 'class') { // class 
            currentAttrValue = condense(currentAttrValue).trim()
          }

          if (quote === QuoteType.Unquoted && !currentAttrValue) {
            emitError(ErrorCodes.MISSING_ATTRIBUTE_VALUE, end)
          }

          currentProp!.value = {
            type: NodeTypes.TEXT,
            content: currentAttrValue,
            loc:
              quote === QuoteType.Unquoted
                ? getLoc(currentAttrStartIndex, currentAttrEndIndex)
                : getLoc(currentAttrStartIndex - 1, currentAttrEndIndex + 1),
          }
          if (
            tokenizer.inSFCRoot &&
            currentOpenTag.tag === 'template' &&
            currentProp.name === 'lang' &&
            currentAttrValue &&
            currentAttrValue !== 'html'
          ) {
            // SFC root template with preprocessor lang, force tokenizer to
            // RCDATA mode
            tokenizer.enterRCDATA(toCharCodes(`</template`), 0)
          }
        } else {
          // directive 处理指令
          let expParseMode = ExpParseMode.Normal // 指令处理，指令的属性值是一个表达式
          if (!__BROWSER__) {
            if (currentProp.name === 'for') {
              expParseMode = ExpParseMode.Skip
            } else if (currentProp.name === 'slot') {
              expParseMode = ExpParseMode.Params
            } else if (
              currentProp.name === 'on' &&
              currentAttrValue.includes(';')
            ) {
              expParseMode = ExpParseMode.Statements
            }
          }
          // 属性值被作为一个表达式
          currentProp.exp = createExp(
            currentAttrValue,
            false,
            getLoc(currentAttrStartIndex, currentAttrEndIndex),
            ConstantTypes.NOT_CONSTANT, // 非静态内容
            expParseMode,
          )
          if (currentProp.name === 'for') { // 如果是v-for指令，还需要解析表达式
            // in前面的部分再创建一个表达式source，in后面的部分创建表达式value
            currentProp.forParseResult = parseForExpression(currentProp.exp)
          }
          // 2.x compat v-bind:foo.sync -> v-model:foo
          let syncIndex = -1
          if (
            __COMPAT__ &&
            currentProp.name === 'bind' &&
            (syncIndex = currentProp.modifiers.indexOf('sync')) > -1 &&
            checkCompatEnabled(
              CompilerDeprecationTypes.COMPILER_V_BIND_SYNC,
              currentOptions,
              currentProp.loc,
              currentProp.rawName,
            )
          ) {
            currentProp.name = 'model'
            currentProp.modifiers.splice(syncIndex, 1)
          }
        }
      }
      if (
        currentProp.type !== NodeTypes.DIRECTIVE || // 如果没有属性值的，那就把当前的属性对象currentProp加入到当前节点原生的props数组中
        currentProp.name !== 'pre'
      ) {
        currentOpenTag.props.push(currentProp)
      }
    }
    currentAttrValue = ''
    currentAttrStartIndex = currentAttrEndIndex = -1
  },

  oncomment(start, end) {
    if (currentOptions.comments) {
      addNode({
        type: NodeTypes.COMMENT,
        content: getSlice(start, end),
        loc: getLoc(start - 4, end + 3),
      })
    }
  },

  // 所有节点处理完毕后的收尾工作
  onend() {
    const end = currentInput.length
    // EOF ERRORS，比如书写不规范，那最后一种状态不是回到了Text状态，给出错误提示
    if ((__DEV__ || !__BROWSER__) && tokenizer.state !== State.Text) {
      switch (tokenizer.state) {
        case State.BeforeTagName:
        case State.BeforeClosingTagName:
          emitError(ErrorCodes.EOF_BEFORE_TAG_NAME, end)
          break
        case State.Interpolation:
        case State.InterpolationClose:
          emitError(
            ErrorCodes.X_MISSING_INTERPOLATION_END,
            tokenizer.sectionStart,
          )
          break
        case State.InCommentLike:
          if (tokenizer.currentSequence === Sequences.CdataEnd) {
            emitError(ErrorCodes.EOF_IN_CDATA, end)
          } else {
            emitError(ErrorCodes.EOF_IN_COMMENT, end)
          }
          break
        case State.InTagName:
        case State.InSelfClosingTag:
        case State.InClosingTagName:
        case State.BeforeAttrName:
        case State.InAttrName:
        case State.InDirName:
        case State.InDirArg:
        case State.InDirDynamicArg:
        case State.InDirModifier:
        case State.AfterAttrName:
        case State.BeforeAttrValue:
        case State.InAttrValueDq: // "
        case State.InAttrValueSq: // '
        case State.InAttrValueNq:
          emitError(ErrorCodes.EOF_IN_TAG, end)
          break
        default:
          // console.log(tokenizer.state)
          break
      }
    }
    //存在某些节点没有闭合，给出错误提示
    for (let index = 0; index < stack.length; index++) {
      onCloseTag(stack[index], end - 1)
      emitError(ErrorCodes.X_MISSING_END_TAG, stack[index].loc.start.offset)
    }
  },

  oncdata(start, end) {
    if (stack[0].ns !== Namespaces.HTML) {
      onText(getSlice(start, end), start, end)
    } else {
      emitError(ErrorCodes.CDATA_IN_HTML_CONTENT, start - 9)
    }
  },

  onprocessinginstruction(start) {
    // ignore as we do not have runtime handling for this, only check error
    if ((stack[0] ? stack[0].ns : currentOptions.ns) === Namespaces.HTML) {
      emitError(
        ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
        start - 1,
      )
    }
  },
})

// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g

// 对表示解析
function parseForExpression(
  input: SimpleExpressionNode,
): ForParseResult | undefined {
  const loc = input.loc
  const exp = input.content
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return

  const [, LHS, RHS] = inMatch // LHS是in前面的部分，RHS是in后面的部分，比如(item, index) in list ，那么LHS是(item, index) RHS是list

  const createAliasExpression = (
    content: string,
    offset: number,
    asParam = false,
  ) => {
    const start = loc.start.offset + offset
    const end = start + content.length
    return createExp(
      content,
      false,
      getLoc(start, end),
      ConstantTypes.NOT_CONSTANT,
      asParam ? ExpParseMode.Params : ExpParseMode.Normal,
    )
  }

  const result: ForParseResult = {
    source: createAliasExpression(RHS.trim(), exp.indexOf(RHS, LHS.length)),
    value: undefined,
    key: undefined,
    index: undefined,
    finalized: false,
  }

  let valueContent = LHS.trim().replace(stripParensRE, '').trim()
  const trimmedOffset = LHS.indexOf(valueContent)

  const iteratorMatch = valueContent.match(forIteratorRE)
  if (iteratorMatch) {
    valueContent = valueContent.replace(forIteratorRE, '').trim()

    const keyContent = iteratorMatch[1].trim()
    let keyOffset: number | undefined
    if (keyContent) {
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      result.key = createAliasExpression(keyContent, keyOffset, true)
    }

    if (iteratorMatch[2]) {
      const indexContent = iteratorMatch[2].trim()

      if (indexContent) {
        result.index = createAliasExpression(
          indexContent,
          exp.indexOf(
            indexContent,
            result.key
              ? keyOffset! + keyContent.length
              : trimmedOffset + valueContent.length,
          ),
          true,
        )
      }
    }
  }

  if (valueContent) {
    result.value = createAliasExpression(valueContent, trimmedOffset, true)
  }

  return result
}

function getSlice(start: number, end: number) {
  return currentInput.slice(start, end)
}

function endOpenTag(end: number) {
  if (tokenizer.inSFCRoot) { // 如果是<template>标签
    // in SFC mode, generate locations for root-level tags' inner content.
    currentOpenTag!.innerLoc = getLoc(end + 1, end + 1)
  }
  // 将当前元素节点添加到stack栈顶元素的children中
  addNode(currentOpenTag!)
  const { tag, ns } = currentOpenTag!
  if (ns === Namespaces.HTML && currentOptions.isPreTag(tag)) {
    inPre++
  }
  if (currentOptions.isVoidTag(tag)) {
    onCloseTag(currentOpenTag!, end)
  } else {
    // 将当前元素放入栈中第一个元素，所以当前父元素就刚创建的节点元素
    stack.unshift(currentOpenTag!)
    if (ns === Namespaces.SVG || ns === Namespaces.MATH_ML) {
      tokenizer.inXML = true
    }
  }
  currentOpenTag = null
}

function onText(content: string, start: number, end: number) {
  if (__BROWSER__) {
    const tag = stack[0]?.tag
    if (tag !== 'script' && tag !== 'style' && content.includes('&')) {
      content = currentOptions.decodeEntities!(content, false)
    }
  }
  // stack 是父级元素栈，记录当前父级元素，默认开始只有根元素
  const parent = stack[0] || currentRoot
  const lastNode = parent.children[parent.children.length - 1]
  // 如果上个节点就是文本节点，直接更新上一个节点
  if (lastNode?.type === NodeTypes.TEXT) {
    // merge
    lastNode.content += content
    setLocEnd(lastNode.loc, end)
  } else {
    // 加入一个文本元素节点
    parent.children.push({
      type: NodeTypes.TEXT,
      content,
      loc: getLoc(start, end),
    })
  }
}

// 闭合元素，元素标签结束，更新元素的位置信息，loc记录的是一个元素节点完整的起始位置和结束位置，比如<h1>hello</h1>，source就是<h1>hello</h1>
/**
 * 用于在解析 HTML 模板时处理闭合标签的逻辑。当解析器遇到一个闭合标签（如 </div>）时，会调用这个函数来完成节点的解析，处理相关的语法和兼容性检查，并更新内部状态。
 */
function onCloseTag(el: ElementNode, end: number, isImplied = false) {
  // attach end position
  if (isImplied) {
    // isImplied为true，说明是标签有错误匹配的情况，比如<div><span></div> 解析到</div>时，会依次推出栈顶元素span和div，推出span时，isImplied就是ture
    // isImplied 参数为 true 时，表示这是一个隐式闭合标签（如 <div><span></div> 中的 <span>）。对于这种情况，需要将标签的结束位置回溯（backTrack）到正确的位置。
    // implied close, end should be backtracked to close
    setLocEnd(el.loc, backTrack(end, CharCodes.Lt))
  } else {
    // 否则，直接将标签的结束位置设置为 end + 1。
    setLocEnd(el.loc, end + 1)
  }

  // 如果当前标签是单文件组件（SFC）的根标签，则更新 innerLoc 的结束位置，并根据子节点的位置计算 innerLoc.source，以便稍后生成代码或调试信息。
  if (tokenizer.inSFCRoot) {
    // SFC root tag, resolve inner end
    if (el.children.length) {
      el.innerLoc!.end = extend({}, el.children[el.children.length - 1].loc.end)
    } else {
      el.innerLoc!.end = extend({}, el.innerLoc!.start)
    }
    el.innerLoc!.source = getSlice(
      el.innerLoc!.start.offset,
      el.innerLoc!.end.offset,
    )
  }

  // refine element type
  //根据当前标签的名称和上下文，进一步确定其类型（tagType），如 SLOT、TEMPLATE、或 COMPONENT。这些类型决定了该节点在编译器中的处理方式。
  const { tag, ns } = el
  if (!inVPre) {
    if (tag === 'slot') {
      el.tagType = ElementTypes.SLOT // slot类型
    } else if (isFragmentTemplate(el)) {
      el.tagType = ElementTypes.TEMPLATE // <template>类型 比如template 上面有v-if/v-for
    } else if (isComponent(el)) { // 组件
      el.tagType = ElementTypes.COMPONENT
    }
  }

  // whitespace management
  // 如果当前不在 RCDATA（如 <textarea> 或 <title>）上下文中，则对子节点中的空白字符进行压缩和规范化，减少不必要的空白。
  if (!tokenizer.inRCDATA) {
    // 处理空白字符
    el.children = condenseWhitespace(el.children, el.tag)
  }
  // 如果当前标签是 <pre>，在离开该标签时，更新相关的状态（inPre、inVPre）以停止 <pre> 模式下的处理。
  if (ns === Namespaces.HTML && currentOptions.isPreTag(tag)) {
    inPre--
  }
  if (currentVPreBoundary === el) {
    inVPre = tokenizer.inVPre = false
    currentVPreBoundary = null
  }
  // 如果解析器之前处于 XML 模式中，但现在进入了 HTML 上下文，重置 inXML 标志。
  if (
    tokenizer.inXML &&
    (stack[0] ? stack[0].ns : currentOptions.ns) === Namespaces.HTML
  ) {
    tokenizer.inXML = false
  }

  // 2.x compat / deprecation checks
  if (__COMPAT__) {
    const props = el.props
    if (
      __DEV__ &&
      isCompatEnabled(
        CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
        currentOptions,
      )
    ) {
      let hasIf = false
      let hasFor = false
      for (let i = 0; i < props.length; i++) {
        const p = props[i]
        if (p.type === NodeTypes.DIRECTIVE) {
          if (p.name === 'if') {
            hasIf = true
          } else if (p.name === 'for') {
            hasFor = true
          }
        }
        if (hasIf && hasFor) {
          warnDeprecation(
            CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
            currentOptions,
            el.loc,
          )
          break
        }
      }
    }

    if (
      !tokenizer.inSFCRoot &&
      isCompatEnabled(
        CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
        currentOptions,
      ) &&
      el.tag === 'template' &&
      !isFragmentTemplate(el)
    ) {
      __DEV__ &&
        warnDeprecation(
          CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
          currentOptions,
          el.loc,
        )
      // unwrap
      const parent = stack[0] || currentRoot
      const index = parent.children.indexOf(el)
      parent.children.splice(index, 1, ...el.children)
    }

    const inlineTemplateProp = props.find(
      p => p.type === NodeTypes.ATTRIBUTE && p.name === 'inline-template',
    ) as AttributeNode
    if (
      inlineTemplateProp &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_INLINE_TEMPLATE,
        currentOptions,
        inlineTemplateProp.loc,
      ) &&
      el.children.length
    ) {
      inlineTemplateProp.value = {
        type: NodeTypes.TEXT,
        content: getSlice(
          el.children[0].loc.start.offset,
          el.children[el.children.length - 1].loc.end.offset,
        ),
        loc: inlineTemplateProp.loc,
      }
    }
  }
}

function backTrack(index: number, c: number) {
  let i = index
  while (currentInput.charCodeAt(i) !== c && i >= 0) i--
  return i
}

const specialTemplateDir = new Set(['if', 'else', 'else-if', 'for', 'slot'])
function isFragmentTemplate({ tag, props }: ElementNode): boolean {
  if (tag === 'template') {
    for (let i = 0; i < props.length; i++) {
      if (
        props[i].type === NodeTypes.DIRECTIVE &&
        specialTemplateDir.has((props[i] as DirectiveNode).name)
      ) {
        return true
      }
    }
  }
  return false
}

// 判断是否时组件：标签名是component、大写、是vue内置组件标签名、不是html元素的标签元素
function isComponent({ tag, props }: ElementNode): boolean {
  if (currentOptions.isCustomElement(tag)) {
    return false
  }
  if (
    tag === 'component' || 
    isUpperCase(tag.charCodeAt(0)) ||
    isCoreComponent(tag) ||
    currentOptions.isBuiltInComponent?.(tag) ||
    (currentOptions.isNativeTag && !currentOptions.isNativeTag(tag))
  ) {
    return true
  }
  // at this point the tag should be a native tag, but check for potential "is"
  // casting
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (p.name === 'is' && p.value) {
        if (p.value.content.startsWith('vue:')) {
          return true
        } else if (
          __COMPAT__ &&
          checkCompatEnabled(
            CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
            currentOptions,
            p.loc,
          )
        ) {
          return true
        }
      }
    } else if (
      __COMPAT__ &&
      // :is on plain element - only treat as component in compat mode
      p.name === 'bind' &&
      isStaticArgOf(p.arg, 'is') &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
        currentOptions,
        p.loc,
      )
    ) {
      return true
    }
  }
  return false
}

function isUpperCase(c: number) {
  return c > 64 && c < 91
}

const windowsNewlineRE = /\r\n/g
// 用于在解析 Vue 模板时，对模板中的文本节点进行空白字符的处理。其目的是根据配置对空白字符进行压缩、删除或规范化，以优化生成的模板代码。
// condenseWhitespace 函数的主要作用是根据配置对模板中的空白字符进行压缩和清理，以优化生成的 AST（抽象语法树）。特别是在不处于 <pre> 标签中时，它会根据条件删除无意义的空白节点，或者将连续的空白字符压缩为单个空格。
function condenseWhitespace(
  nodes: TemplateChildNode[],
  tag?: string,
): TemplateChildNode[] {
  const shouldCondense = currentOptions.whitespace !== 'preserve'
  let removedWhitespace = false
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type === NodeTypes.TEXT) {
      // 如果不在 <pre> 标签中，则对空白字符进行压缩和删除处理。<pre> 标签中的内容通常保留所有的空白字符。
      if (!inPre) {
        // 如果文本节点内容全为空白字符，则进一步检查是否应该删除这个节点。
        if (isAllWhitespace(node.content)) {
          const prev = nodes[i - 1]?.type
          const next = nodes[i + 1]?.type
          // Remove if:
          // - the whitespace is the first or last node, or:
          // - (condense mode) the whitespace is between two comments, or:
          // - (condense mode) the whitespace is between comment and element, or:
          // - (condense mode) the whitespace is between two elements AND contains newline
          /**
           * 如果节点是首个或末尾节点。
           * 如果处于压缩模式，并且空白节点位于两个注释之间，或位于注释和元素之间，或位于两个元素之间且包含换行符。
           * 如果满足删除条件，删除该节点（即将其置为 null）。
              否则，将该空白节点的内容压缩为一个空格字符 ' '。
           */
          if (
            !prev ||
            !next ||
            (shouldCondense &&
              ((prev === NodeTypes.COMMENT &&
                (next === NodeTypes.COMMENT || next === NodeTypes.ELEMENT)) ||
                (prev === NodeTypes.ELEMENT &&
                  (next === NodeTypes.COMMENT ||
                    (next === NodeTypes.ELEMENT &&
                      hasNewlineChar(node.content))))))
          ) {
            removedWhitespace = true
            nodes[i] = null as any
          } else {
            // Otherwise, the whitespace is condensed into a single space
            node.content = ' '
          }
        } else if (shouldCondense) {
          // in condense mode, consecutive whitespaces in text are condensed
          // down to a single space.
          // 对非全空白的文本节点，进行空白字符的压缩，即将连续的多个空白字符压缩为单个空格。
          node.content = condense(node.content)
        }
      } else {
        // #6410 normalize windows newlines in <pre>:
        // in SSR, browsers normalize server-rendered \r\n into a single \n
        // in the DOM
        // 对 <pre> 标签中的文本内容，将 Windows 样式的换行符 \r\n 替换为单个 \n。
        node.content = node.content.replace(windowsNewlineRE, '\n')
      }
    }
  }
  // 如果当前正在处理 <pre> 标签，按照 HTML 规范，移除开头的换行符。
  if (inPre && tag && currentOptions.isPreTag(tag)) {
    // remove leading newline per html spec
    // https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
    const first = nodes[0]
    if (first && first.type === NodeTypes.TEXT) {
      first.content = first.content.replace(/^\r?\n/, '')
    }
  }
  // 如果有节点被标记为 null，则通过 filter(Boolean) 过滤掉这些节点，返回处理后的节点数组。
  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

function isAllWhitespace(str: string) {
  for (let i = 0; i < str.length; i++) {
    if (!isWhitespace(str.charCodeAt(i))) {
      return false
    }
  }
  return true
}

function hasNewlineChar(str: string) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c === CharCodes.NewLine || c === CharCodes.CarriageReturn) {
      return true
    }
  }
  return false
}

function condense(str: string) {
  let ret = ''
  let prevCharIsWhitespace = false
  for (let i = 0; i < str.length; i++) {
    if (isWhitespace(str.charCodeAt(i))) {
      if (!prevCharIsWhitespace) {
        ret += ' '
        prevCharIsWhitespace = true
      }
    } else {
      ret += str[i]
      prevCharIsWhitespace = false
    }
  }
  return ret
}

function addNode(node: TemplateChildNode) {
  ;(stack[0] || currentRoot).children.push(node)
}

function getLoc(start: number, end?: number): SourceLocation {
  return {
    start: tokenizer.getPos(start),
    // @ts-expect-error allow late attachment
    end: end == null ? end : tokenizer.getPos(end),
    // @ts-expect-error allow late attachment
    source: end == null ? end : getSlice(start, end),
  }
}

function setLocEnd(loc: SourceLocation, end: number) {
  loc.end = tokenizer.getPos(end)
  loc.source = getSlice(loc.start.offset, end)
}

function dirToAttr(dir: DirectiveNode): AttributeNode {
  const attr: AttributeNode = {
    type: NodeTypes.ATTRIBUTE,
    name: dir.rawName!,
    nameLoc: getLoc(
      dir.loc.start.offset,
      dir.loc.start.offset + dir.rawName!.length,
    ),
    value: undefined,
    loc: dir.loc,
  }
  if (dir.exp) {
    // account for quotes
    const loc = dir.exp.loc
    if (loc.end.offset < dir.loc.end.offset) {
      loc.start.offset--
      loc.start.column--
      loc.end.offset++
      loc.end.column++
    }
    attr.value = {
      type: NodeTypes.TEXT,
      content: (dir.exp as SimpleExpressionNode).content,
      loc,
    }
  }
  return attr
}

enum ExpParseMode {
  Normal,
  Params, // 参数
  Statements, // 陈述句
  Skip,
}

function createExp(
  content: SimpleExpressionNode['content'],
  isStatic: SimpleExpressionNode['isStatic'] = false,
  loc: SourceLocation,
  constType: ConstantTypes = ConstantTypes.NOT_CONSTANT, // not constant
  parseMode = ExpParseMode.Normal,
) {
  const exp = createSimpleExpression(content, isStatic, loc, constType)
  if (
    !__BROWSER__ &&
    !isStatic &&
    currentOptions.prefixIdentifiers &&
    parseMode !== ExpParseMode.Skip &&
    content.trim()
  ) {
    if (isSimpleIdentifier(content)) {
      exp.ast = null // fast path
      return exp
    }
    try {
      const plugins = currentOptions.expressionPlugins
      const options: BabelOptions = {
        plugins: plugins ? [...plugins, 'typescript'] : ['typescript'],
      }
      if (parseMode === ExpParseMode.Statements) {
        // v-on with multi-inline-statements, pad 1 char
        exp.ast = parse(` ${content} `, options).program
      } else if (parseMode === ExpParseMode.Params) {
        exp.ast = parseExpression(`(${content})=>{}`, options)
      } else {
        // normal exp, wrap with parens
        exp.ast = parseExpression(`(${content})`, options)
      }
    } catch (e: any) {
      exp.ast = false // indicate an error
      emitError(ErrorCodes.X_INVALID_EXPRESSION, loc.start.offset, e.message)
    }
  }
  return exp
}

function emitError(code: ErrorCodes, index: number, message?: string) {
  currentOptions.onError(
    createCompilerError(code, getLoc(index, index), undefined, message),
  )
}

function reset() {
  tokenizer.reset()
  currentOpenTag = null
  currentProp = null
  currentAttrValue = ''
  currentAttrStartIndex = -1
  currentAttrEndIndex = -1
  stack.length = 0
}

// options就是上下文
export function baseParse(input: string, options?: ParserOptions): RootNode {
  reset() // 重置状态
  currentInput = input //模板文本
  currentOptions = extend({}, defaultParserOptions) //参数

  if (options) {
    let key: keyof ParserOptions
    for (key in options) {
      if (options[key] != null) {
        // @ts-expect-error
        currentOptions[key] = options[key]
      }
    }
  }

  if (__DEV__) {
    if (!__BROWSER__ && currentOptions.decodeEntities) {
      console.warn(
        `[@vue/compiler-core] decodeEntities option is passed but will be ` +
          `ignored in non-browser builds.`,
      )
    } else if (__BROWSER__ && !currentOptions.decodeEntities) {
      throw new Error(
        `[@vue/compiler-core] decodeEntities option is required in browser builds.`,
      )
    }
  }

  // 状态机的运行模式
  tokenizer.mode =
    currentOptions.parseMode === 'html'
      ? ParseMode.HTML
      : currentOptions.parseMode === 'sfc'
        ? ParseMode.SFC
        : ParseMode.BASE

  tokenizer.inXML =
    currentOptions.ns === Namespaces.SVG ||
    currentOptions.ns === Namespaces.MATH_ML

    //插值符号，默认是用{{}}
  const delimiters = options?.delimiters
  if (delimiters) {
    tokenizer.delimiterOpen = toCharCodes(delimiters[0])
    tokenizer.delimiterClose = toCharCodes(delimiters[1])
  }

  // 创建一个根节点，children就是用来存放解析模板后的元素
  const root = (currentRoot = createRoot([], input))
  //解析整个模板，通过状态机tokenizer对象，以及具体节点在parse中出，html模板就会转成AST树结构
  tokenizer.parse(currentInput)
  // 计算根节点的位置
  root.loc = getLoc(0, input.length)
  //把根节点前后多余的空白内容去掉
  root.children = condenseWhitespace(root.children)
  currentRoot = null
  // 返回ast树
  return root
}
