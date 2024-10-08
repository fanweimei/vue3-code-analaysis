import type {
  ElementNode,
  Namespace,
  Namespaces,
  ParentNode,
  TemplateChildNode,
} from './ast'
import type { CompilerError } from './errors'
import type {
  DirectiveTransform,
  NodeTransform,
  TransformContext,
} from './transform'
import type { CompilerCompatOptions } from './compat/compatConfig'
import type { ParserPlugin } from '@babel/parser'

export interface ErrorHandlingOptions {
  onWarn?: (warning: CompilerError) => void
  onError?: (error: CompilerError) => void
}

// ParserOptions 接口用于配置模板解析器的各种选项。这些选项可以控制解析器如何处理模板中的标签、命名空间、空白、注释等
export interface ParserOptions
  extends ErrorHandlingOptions,
    CompilerCompatOptions {
  /**
   * Base mode is platform agnostic and only parses HTML-like template syntax,
   * treating all tags the same way. Specific tag parsing behavior can be
   * configured by higher-level compilers.
   *
   * HTML mode adds additional logic for handling special parsing behavior in
   * `<script>`, `<style>`,`<title>` and `<textarea>`.
   * The logic is handled inside compiler-core for efficiency.
   *
   * SFC mode treats content of all root-level tags except `<template>` as plain
   * text.
   * base: 基础模式，解析器在该模式下只解析 HTML 类似的模板语法，所有标签的处理方式相同。
     html: HTML 模式，增加了对特殊标签（如 <script>、<style>、<title>、<textarea>）的解析逻辑。
     sfc: 单文件组件（SFC）模式，处理根级别标签（除 <template> 外）的内容为纯文本。
   */
  parseMode?: 'base' | 'html' | 'sfc'
  /**
   * Specify the root namespace to use when parsing a template.
   * Defaults to `Namespaces.HTML` (0).
   * 定解析模板时使用的根命名空间。 定义命名空间（如 Namespaces.HTML）以确定如何解析特定标签。默认是 Namespaces.HTML
   */
  ns?: Namespaces
  /**
   * e.g. platform native elements, e.g. `<div>` for browsers
   * 检查一个标签是否为平台的原生标签。
   */
  isNativeTag?: (tag: string) => boolean
  /**
   * e.g. native elements that can self-close, e.g. `<img>`, `<br>`, `<hr>`
   * 检查一个标签是否为自闭合标签
   */
  isVoidTag?: (tag: string) => boolean
  /**
   * e.g. elements that should preserve whitespace inside, e.g. `<pre>`
   * 检查一个标签是否应该保留内部的空白字符。 对于像 <pre> 这样的标签，需要保留其内部的空白字符
   */
  isPreTag?: (tag: string) => boolean
  /**
   * Platform-specific built-in components e.g. `<Transition>`
   * 检查一个标签是否为平台特定的内置组件。
   */
  isBuiltInComponent?: (tag: string) => symbol | void
  /**
   * Separate option for end users to extend the native elements list
   * 允许用户扩展原生元素列表以识别自定义元素。
   */
  isCustomElement?: (tag: string) => boolean | void
  /**
   * Get tag namespace
   * 解析器根据标签名、父元素以及根命名空间确定当前标签的命名空间。
   */
  getNamespace?: (
    tag: string,
    parent: ElementNode | undefined,
    rootNamespace: Namespace,
  ) => Namespace
  /**
   * @default ['{{', '}}']
   * 指定模板中插值表达式的分界符。例如，默认的分界符是 ['{{', '}}']，可以自定义为其他分界符以避免与其他模板语言冲突。
   */
  delimiters?: [string, string]
  /**
   * Whitespace handling strategy
   * 指定空白字符的处理策略。
   * preserve: 保留所有空白字符。
    condense: 把空白字符压缩为一个空格
   */
  whitespace?: 'preserve' | 'condense'
  /**
   * Only used for DOM compilers that runs in the browser.
   * In non-browser builds, this option is ignored.
   * 解析 HTML 实体的函数。
   */
  decodeEntities?: (rawText: string, asAttr: boolean) => string
  /**
   * Whether to keep comments in the templates AST.
   * This defaults to `true` in development and `false` in production builds.
   * 是否在模板的抽象语法树（AST）中保留注释。
   * 在开发环境中默认保留注释（true），在生产环境中默认不保留（false）。
   */
  comments?: boolean
  /**
   * Parse JavaScript expressions with Babel.
   * @default false
   * 是否使用 Babel 解析 JavaScript 表达式时前缀标识符。
   * 如果设为 true，则会在表达式解析时为变量名添加前缀，以避免命名冲突。默认为 false。
   */
  prefixIdentifiers?: boolean
  /**
   * A list of parser plugins to enable for `@babel/parser`, which is used to
   * parse expressions in bindings and interpolations.
   * https://babeljs.io/docs/en/next/babel-parser#plugins
   * 指定 @babel/parser 的插件列表，用于解析模板中的表达式和插值。
   * 可以启用特定的 Babel 插件来支持新的 JavaScript 语法特性，比如 TypeScript、JSX 等。
   */
  expressionPlugins?: ParserPlugin[]
}

export type HoistTransform = (
  children: TemplateChildNode[],
  context: TransformContext,
  parent: ParentNode,
) => void

export enum BindingTypes {
  /**
   * returned from data()
   */
  DATA = 'data',
  /**
   * declared as a prop
   */
  PROPS = 'props',
  /**
   * a local alias of a `<script setup>` destructured prop.
   * the original is stored in __propsAliases of the bindingMetadata object.
   */
  PROPS_ALIASED = 'props-aliased',
  /**
   * a let binding (may or may not be a ref)
   */
  SETUP_LET = 'setup-let',
  /**
   * a const binding that can never be a ref.
   * these bindings don't need `unref()` calls when processed in inlined
   * template expressions.
   */
  SETUP_CONST = 'setup-const',
  /**
   * a const binding that does not need `unref()`, but may be mutated.
   */
  SETUP_REACTIVE_CONST = 'setup-reactive-const',
  /**
   * a const binding that may be a ref.
   */
  SETUP_MAYBE_REF = 'setup-maybe-ref',
  /**
   * bindings that are guaranteed to be refs
   */
  SETUP_REF = 'setup-ref',
  /**
   * declared by other options, e.g. computed, inject
   */
  OPTIONS = 'options',
  /**
   * a literal constant, e.g. 'foo', 1, true
   */
  LITERAL_CONST = 'literal-const',
}

export type BindingMetadata = {
  [key: string]: BindingTypes | undefined
} & {
  __isScriptSetup?: boolean
  __propsAliases?: Record<string, string>
}

interface SharedTransformCodegenOptions {
  /**
   * Transform expressions like {{ foo }} to `_ctx.foo`.
   * If this option is false, the generated code will be wrapped in a
   * `with (this) { ... }` block.
   * - This is force-enabled in module mode, since modules are by default strict
   * and cannot use `with`
   * @default mode === 'module'
   */
  prefixIdentifiers?: boolean
  /**
   * Control whether generate SSR-optimized render functions instead.
   * The resulting function must be attached to the component via the
   * `ssrRender` option instead of `render`.
   *
   * When compiler generates code for SSR's fallback branch, we need to set it to false:
   *  - context.ssr = false
   *
   * see `subTransform` in `ssrTransformComponent.ts`
   */
  ssr?: boolean
  /**
   * Indicates whether the compiler generates code for SSR,
   * it is always true when generating code for SSR,
   * regardless of whether we are generating code for SSR's fallback branch,
   * this means that when the compiler generates code for SSR's fallback branch:
   *  - context.ssr = false
   *  - context.inSSR = true
   */
  inSSR?: boolean
  /**
   * Optional binding metadata analyzed from script - used to optimize
   * binding access when `prefixIdentifiers` is enabled.
   */
  bindingMetadata?: BindingMetadata
  /**
   * Compile the function for inlining inside setup().
   * This allows the function to directly access setup() local bindings.
   */
  inline?: boolean
  /**
   * Indicates that transforms and codegen should try to output valid TS code
   */
  isTS?: boolean
  /**
   * Filename for source map generation.
   * Also used for self-recursive reference in templates
   * @default 'template.vue.html'
   */
  filename?: string
}

//TransformOptions 接口定义了在模板编译过程中应用于抽象语法树（AST）的各种转换选项。这些选项允许开发者自定义模板的编译行为，以生成符合特定需求的代码。
export interface TransformOptions
  extends SharedTransformCodegenOptions,
    ErrorHandlingOptions,
    CompilerCompatOptions {
  /**
   * An array of node transforms to be applied to every AST node.
   * 一个用于转换每个 AST 节点的转换函数数组。
   */
  nodeTransforms?: NodeTransform[]
  /**
   * An object of { name: transform } to be applied to every directive attribute
   * node found on element nodes.
   * 一个对象，用于对元素节点上的每个指令属性节点应用转换。
   */
  directiveTransforms?: Record<string, DirectiveTransform | undefined>
  /**
   * An optional hook to transform a node being hoisted.
   * used by compiler-dom to turn hoisted nodes into stringified HTML vnodes.
   * @default null
   * 一个可选的钩子，用于转换被提升的节点。
   * 在编译过程中，将静态内容提升为常量，这个钩子可以自定义如何处理这些被提升的节点。例如，在 DOM 编译器中，将提升的节点转换为字符串化的 HTML 虚拟节点（VNode）。
   */
  transformHoist?: HoistTransform | null
  /**
   * If the pairing runtime provides additional built-in elements, use this to
   * mark them as built-in so the compiler will generate component vnodes
   * for them.
   */
  isBuiltInComponent?: (tag: string) => symbol | void
  /**
   * Used by some transforms that expects only native elements
   */
  isCustomElement?: (tag: string) => boolean | void
  /**
   * Transform expressions like {{ foo }} to `_ctx.foo`.
   * If this option is false, the generated code will be wrapped in a
   * `with (this) { ... }` block.
   * - This is force-enabled in module mode, since modules are by default strict
   * and cannot use `with`
   * @default mode === 'module'
   * 将表达式（如 {{ foo }}）转换为 _ctx.foo
   * 如果设置为 false，生成的代码将包裹在 with (this) { ... } 块中。这在模块模式中会强制启用，因为模块默认是严格模式，不能使用 with 语句。默认为 mode === 'module'。
   */
  prefixIdentifiers?: boolean
  /**
   * Hoist static VNodes and props objects to `_hoisted_x` constants
   * @default false
   * 将静态 VNode 和属性对象提升为 _hoisted_x 常量。
   * 默认值为 false。开启后，可以减少重新渲染时的内存占用和性能开销，因为静态内容不需要在每次渲染时重新创建。
   */
  hoistStatic?: boolean
  /**
   * Cache v-on handlers to avoid creating new inline functions on each render,
   * also avoids the need for dynamically patching the handlers by wrapping it.
   * e.g `@click="foo"` by default is compiled to `{ onClick: foo }`. With this
   * option it's compiled to:
   * ```js
   * { onClick: _cache[0] || (_cache[0] = e => _ctx.foo(e)) }
   * ```
   * - Requires "prefixIdentifiers" to be enabled because it relies on scope
   * analysis to determine if a handler is safe to cache.
   * @default false
   * 缓存 v-on 事件处理器，以避免在每次渲染时创建新的内联函数。
   * 例如，默认情况下 @click="foo" 会编译为 { onClick: foo }。启用该选项后，代码会变为 { onClick: _cache[0] || (_cache[0] = e => _ctx.foo(e)) }，
   * 这有助于减少不必要的动态更新。需要 prefixIdentifiers 选项启用，以确保处理器缓存的安全性。
   */
  cacheHandlers?: boolean
  /**
   * A list of parser plugins to enable for `@babel/parser`, which is used to
   * parse expressions in bindings and interpolations.
   * https://babeljs.io/docs/en/next/babel-parser#plugins
   * 指定用于 @babel/parser 的解析插件列表。
   * 用于解析模板中绑定和插值表达式的插件。可以启用特定的 Babel 插件来支持新的 JavaScript 语法特性，例如 TypeScript、JSX 等。
   */
  expressionPlugins?: ParserPlugin[]
  /**
   * SFC scoped styles ID
   * 单文件组件（SFC）中作用域样式的 ID。
   * 这个 ID 会添加到组件的根元素及其子元素中，以确保样式只在当前组件内生效。用于生成具备作用域的样式代码。
   */
  scopeId?: string | null
  /**
   * Indicates this SFC template has used :slotted in its styles
   * Defaults to `true` for backwards compatibility - SFC tooling should set it
   * to `false` if no `:slotted` usage is detected in `<style>`
   * 指示这个 SFC 模板是否在样式中使用了 :slotted。
   * 默认值为 true，以保持向后兼容性。如果在 <style> 中没有检测到 :slotted 的使用，SFC 工具链应将其设置为 false。
   */
  slotted?: boolean
  /**
   * SFC `<style vars>` injection string
   * Should already be an object expression, e.g. `{ 'xxxx-color': color }`
   * needed to render inline CSS variables on component root
   */
  ssrCssVars?: string
  /**
   * Whether to compile the template assuming it needs to handle HMR.
   * Some edge cases may need to generate different code for HMR to work
   * correctly, e.g. #6938, #7138
   */
  hmr?: boolean
}

// 接口定义了代码生成阶段的选项。这些选项用于控制模板编译器如何生成渲染函数或其他输出代码
export interface CodegenOptions extends SharedTransformCodegenOptions {
  /**
   * - `module` mode will generate ES module import statements for helpers
   * and export the render function as the default export.
   * - `function` mode will generate a single `const { helpers... } = Vue`
   * statement and return the render function. It expects `Vue` to be globally
   * available (or passed by wrapping the code with an IIFE). It is meant to be
   * used with `new Function(code)()` to generate a render function at runtime.
   * @default 'function'
   * 指定代码生成的模式。
   * 'module': 生成 ES 模块导入语句，用于引入辅助函数，并将渲染函数作为默认导出。适用于现代 JavaScript 环境。
   * 'function': 生成一个包含 const { helpers... } = Vue 的语句，并返回渲染函数。期望 Vue 在全局环境中可用，或者通过自调用函数 (IIFE) 传递。适用于在运行时通过 new Function(code)() 动态生成渲染函数。默认值为 'function'。
   */
  mode?: 'module' | 'function'
  /**
   * Generate source map?
   * @default false
   * 是否生成源码映射（source map）。
   */
  sourceMap?: boolean
  /**
   * SFC scoped styles ID
   * 单文件组件（SFC）中作用域样式的 ID。
   */
  scopeId?: string | null
  /**
   * Option to optimize helper import bindings via variable assignment
   * (only used for webpack code-split)
   * @default false
   * 是否通过变量赋值优化辅助函数的导入绑定（仅用于 webpack 代码分割）。
   * 如果启用，在代码分割场景中，会生成更优化的导入语句，以减少冗余代码。默认值为 false。
   */
  optimizeImports?: boolean
  /**
   * Customize where to import runtime helpers from.
   * @default 'vue'
   * 自定义引入运行时辅助函数的模块名。
   * 指定辅助函数从哪个模块引入。默认值为 'vue'，即从 Vue 的主模块中导入。
   */
  runtimeModuleName?: string
  /**
   * Customize where to import ssr runtime helpers from/**
   * @default 'vue/server-renderer'
   * 自定义引入服务端渲染 (SSR) 运行时辅助函数的模块名。
   * 在服务端渲染时，指定辅助函数从哪个模块引入。默认值为 'vue/server-renderer'。
   */
  ssrRuntimeModuleName?: string
  /**
   * Customize the global variable name of `Vue` to get helpers from
   * in function mode
   * @default 'Vue'
   * 在 function 模式下，自定义 Vue 全局变量名，用于获取辅助函数。
   * 当使用 'function' 模式时，可以指定一个全局变量名，以便从中获取 Vue 的辅助函数。默认值为 'Vue'。
   */
  runtimeGlobalName?: string
}

export type CompilerOptions = ParserOptions & TransformOptions & CodegenOptions
