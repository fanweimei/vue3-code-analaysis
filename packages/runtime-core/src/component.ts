import { type VNode, type VNodeChild, isVNode } from './vnode'
import {
  EffectScope,
  type ReactiveEffect,
  TrackOpTypes,
  isRef,
  markRaw,
  pauseTracking,
  proxyRefs,
  resetTracking,
  shallowReadonly,
  track,
} from '@vue/reactivity'
import {
  type ComponentPublicInstance,
  type ComponentPublicInstanceConstructor,
  PublicInstanceProxyHandlers,
  RuntimeCompiledPublicInstanceProxyHandlers,
  createDevRenderContext,
  exposePropsOnRenderContext,
  exposeSetupStateOnRenderContext,
  publicPropertiesMap,
} from './componentPublicInstance'
import {
  type ComponentPropsOptions,
  type NormalizedPropsOptions,
  initProps,
  normalizePropsOptions,
} from './componentProps'
import {
  type InternalSlots,
  type Slots,
  type SlotsType,
  type UnwrapSlotsType,
  initSlots,
} from './componentSlots'
import { warn } from './warning'
import { ErrorCodes, callWithErrorHandling, handleError } from './errorHandling'
import {
  type AppConfig,
  type AppContext,
  createAppContext,
} from './apiCreateApp'
import { type Directive, validateDirectiveName } from './directives'
import {
  type ComponentOptions,
  type ComputedOptions,
  type MethodOptions,
  applyOptions,
  resolveMergedOptions,
} from './componentOptions'
import {
  type EmitFn,
  type EmitsOptions,
  type EmitsToProps,
  type ObjectEmitsOptions,
  type ShortEmitsToObject,
  emit,
  normalizeEmitsOptions,
} from './componentEmits'
import {
  EMPTY_OBJ,
  type IfAny,
  NO,
  NOOP,
  ShapeFlags,
  extend,
  getGlobalThis,
  isArray,
  isFunction,
  isObject,
  isPromise,
  makeMap,
} from '@vue/shared'
import type { SuspenseBoundary } from './components/Suspense'
import type { CompilerOptions } from '@vue/compiler-core'
import { markAttrsAccessed } from './componentRenderUtils'
import { currentRenderingInstance } from './componentRenderContext'
import { endMeasure, startMeasure } from './profiling'
import { convertLegacyRenderFn } from './compat/renderFn'
import {
  type CompatConfig,
  globalCompatConfig,
  validateCompatConfig,
} from './compat/compatConfig'
import type { SchedulerJob } from './scheduler'
import type { LifecycleHooks } from './enums'

export type Data = Record<string, unknown>

/**
 * Public utility type for extracting the instance type of a component.
 * Works with all valid component definition types. This is intended to replace
 * the usage of `InstanceType<typeof Comp>` which only works for
 * constructor-based component definition types.
 *
 * Exmaple:
 * ```ts
 * const MyComp = { ... }
 * declare const instance: ComponentInstance<typeof MyComp>
 * ```
 */
export type ComponentInstance<T> = T extends { new (): ComponentPublicInstance }
  ? InstanceType<T>
  : T extends FunctionalComponent<infer Props, infer Emits>
    ? ComponentPublicInstance<Props, {}, {}, {}, {}, ShortEmitsToObject<Emits>>
    : T extends Component<
          infer Props,
          infer RawBindings,
          infer D,
          infer C,
          infer M
        >
      ? // NOTE we override Props/RawBindings/D to make sure is not `unknown`
        ComponentPublicInstance<
          unknown extends Props ? {} : Props,
          unknown extends RawBindings ? {} : RawBindings,
          unknown extends D ? {} : D,
          C,
          M
        >
      : never // not a vue Component

/**
 * For extending allowed non-declared props on components in TSX
 */
export interface ComponentCustomProps {}

/**
 * Default allowed non-declared props on component in TSX
 */
export interface AllowedComponentProps {
  class?: unknown
  style?: unknown
}

// Note: can't mark this whole interface internal because some public interfaces
// extend it.
export interface ComponentInternalOptions {
  /**
   * @internal
   */
  __scopeId?: string
  /**
   * @internal
   */
  __cssModules?: Data
  /**
   * @internal
   */
  __hmrId?: string
  /**
   * Compat build only, for bailing out of certain compatibility behavior
   */
  __isBuiltIn?: boolean
  /**
   * This one should be exposed so that devtools can make use of it
   */
  __file?: string
  /**
   * name inferred from filename
   */
  __name?: string
}
// 函数式的组件类型

export interface FunctionalComponent<
  P = {},
  E extends EmitsOptions | Record<string, any[]> = {},
  S extends Record<string, any> = any,
  EE extends EmitsOptions = ShortEmitsToObject<E>,
> extends ComponentInternalOptions {
  // use of any here is intentional so it can be a valid JSX Element constructor
  (
    props: P & EmitsToProps<EE>,
    ctx: Omit<SetupContext<EE, IfAny<S, {}, SlotsType<S>>>, 'expose'>,
  ): any
  props?: ComponentPropsOptions<P>
  emits?: EE | (keyof EE)[]
  slots?: IfAny<S, Slots, SlotsType<S>>
  inheritAttrs?: boolean
  displayName?: string
  compatConfig?: CompatConfig
}

export interface ClassComponent {
  new (...args: any[]): ComponentPublicInstance<any, any, any, any, any>
  __vccOpts: ComponentOptions
}

/**
 * Concrete component type matches its actual value: it's either an options
 * object, or a function. Use this where the code expects to work with actual
 * values, e.g. checking if its a function or not. This is mostly for internal
 * implementation code.
 */
// ConcreteComponent 组件类型定义（函数式组件、组件配置对象）
export type ConcreteComponent<
  Props = {},
  RawBindings = any,
  D = any,
  C extends ComputedOptions = ComputedOptions,
  M extends MethodOptions = MethodOptions,
  E extends EmitsOptions | Record<string, any[]> = {},
  S extends Record<string, any> = any,
> =
  | ComponentOptions<Props, RawBindings, D, C, M>
  | FunctionalComponent<Props, E, S>

/**
 * A type used in public APIs where a component type is expected.
 * The constructor type is an artificial type returned by defineComponent().
 */
export type Component<
  Props = any,
  RawBindings = any,
  D = any,
  C extends ComputedOptions = ComputedOptions,
  M extends MethodOptions = MethodOptions,
  E extends EmitsOptions | Record<string, any[]> = {},
  S extends Record<string, any> = any,
> =
  | ConcreteComponent<Props, RawBindings, D, C, M, E, S>
  | ComponentPublicInstanceConstructor<Props> //用于标识一个 Vue 组件实例的构造函数的类型，这个构造函数会生成一个组件的公共实例。
// 组件配置对象
export type { ComponentOptions }

type LifecycleHook<TFn = Function> = TFn[] | null

// use `E extends any` to force evaluating type to fix #2362
export type SetupContext<
  E = EmitsOptions,
  S extends SlotsType = {},
> = E extends any
  ? {
      attrs: Data
      slots: UnwrapSlotsType<S>
      emit: EmitFn<E>
      expose: (exposed?: Record<string, any>) => void
    }
  : never

/**
 * @internal
 */
export type InternalRenderFunction = {
  (
    ctx: ComponentPublicInstance,
    cache: ComponentInternalInstance['renderCache'],
    // for compiler-optimized bindings
    $props: ComponentInternalInstance['props'],
    $setup: ComponentInternalInstance['setupState'],
    $data: ComponentInternalInstance['data'],
    $options: ComponentInternalInstance['ctx'],
  ): VNodeChild
  _rc?: boolean // isRuntimeCompiled

  // __COMPAT__ only
  _compatChecked?: boolean // v3 and already checked for v2 compat
  _compatWrapped?: boolean // is wrapped for v2 compat
}

/**
 * We expose a subset of properties on the internal instance as they are
 * useful for advanced external libraries and tools.
 * 组件的实例对象
 */
export interface ComponentInternalInstance {
  uid: number // 组件实例的唯一标识符
  type: ConcreteComponent // 组件的类型，通常是组件的构造函数或者定义对象。
  parent: ComponentInternalInstance | null // 父组件的实例，如果当前组件是根组件，则为 null。
  root: ComponentInternalInstance //根组件的实例
  appContext: AppContext //应用的上下文，包含应用范围内的配置信息和注入的内容。
  /**
   * Vnode representing this component in its parent's vdom tree
   */
  vnode: VNode // 表示当前组件在父组件的虚拟 DOM 树中的 VNode。
  /**
   * The pending new vnode from parent updates
   * @internal
   */
  next: VNode | null // 表示从父组件更新时待处理的新 VNode。
  /**
   * Root vnode of this component's own vdom tree
   */
  subTree: VNode // 当前组件自身虚拟 DOM 树的根 VNode。
  /**
   * Render effect instance
   */
  effect: ReactiveEffect // 当前组件的渲染副作用，用于在响应式数据变化时重新渲染组件。
  /**
   * Bound effect runner to be passed to schedulers
   */
  update: SchedulerJob // 绑定的副作用运行函数，用于调度更新。
  /**
   * The render function that returns vdom tree.
   * @internal
   */
  render: InternalRenderFunction | null // 渲染函数，返回组件的虚拟 DOM 树。
  /**
   * SSR render function
   * @internal
   */
  ssrRender?: Function | null //服务器端渲染的渲染函数。
  /**
   * Object containing values this component provides for its descendants
   * @internal
   */
  provides: Data //当前组件为其后代组件提供的依赖。
  /**
   * Tracking reactive effects (e.g. watchers) associated with this component
   * so that they can be automatically stopped on component unmount
   * @internal
   */
  scope: EffectScope //用于跟踪与此组件关联的响应式副作用，以便在组件卸载时自动停止
  /**
   * cache for proxy access type to avoid hasOwnProperty calls
   * @internal
   */
  accessCache: Data | null //用于缓存代理访问类型以避免 hasOwnProperty 调用。
  /**
   * cache for render function values that rely on _ctx but won't need updates
   * after initialized (e.g. inline handlers)
   * @internal
   */
  renderCache: (Function | VNode)[] //用于缓存依赖于 ctx 但不需要更新的渲染函数值。

  /**
   * Resolved component registry, only for components with mixins or extends
   * @internal
   */
  components: Record<string, ConcreteComponent> | null // 解析的组件注册表，仅适用于包含混入或扩展的组件。
  /**
   * Resolved directive registry, only for components with mixins or extends
   * @internal
   */
  directives: Record<string, Directive> | null //解析的指令注册表，仅适用于包含混入或扩展的组件。
  /**
   * Resolved filters registry, v2 compat only
   * @internal
   */
  filters?: Record<string, Function> //解析的过滤器注册表，仅用于 Vue 2 兼容性。
  /**
   * resolved props options
   * @internal
   */
  propsOptions: NormalizedPropsOptions //解析后的 props 选项。
  /**
   * resolved emits options
   * @internal
   */
  emitsOptions: ObjectEmitsOptions | null //解析后的 emits 选项。
  /**
   * resolved inheritAttrs options
   * @internal
   */
  inheritAttrs?: boolean //是否继承未声明的属性。
  /**
   * is custom element?
   * @internal
   */
  isCE?: boolean //是否为自定义元素。
  /**
   * custom element specific HMR method
   * @internal
   */
  ceReload?: (newStyles?: string[]) => void //自定义元素特有的 HMR 方法。

  // the rest are only for stateful components ---------------------------------

  // main proxy that serves as the public instance (`this`)
  proxy: ComponentPublicInstance | null //主要的代理对象，作为公开实例（this）

  // exposed properties via expose()
  exposed: Record<string, any> | null //通过 expose() 暴露的属性。
  exposeProxy: Record<string, any> | null //公开代理暴露的对象。

  /**
   * alternative proxy used only for runtime-compiled render functions using
   * `with` block
   * @internal
   */
  withProxy: ComponentPublicInstance | null //仅用于运行时编译渲染函数使用 with 块的替代代理。
  /**
   * This is the target for the public instance proxy. It also holds properties
   * injected by user options (computed, methods etc.) and user-attached
   * custom properties (via `this.x = ...`)
   * @internal
   */
  ctx: Data //公开实例代理的目标，也持有由用户选项（计算属性、方法等）注入的属性。

  // state
  data: Data //组件的响应式数据对象。
  props: Data //组件的 props 数据。
  attrs: Data //传递给组件但未声明为 props 的属性。
  slots: InternalSlots //组件的插槽内容。
  refs: Data //组件的 refs 对象。
  emit: EmitFn //用于触发自定义事件的函数。

  attrsProxy: Data | null //attrs 的代理对象。
  slotsProxy: Slots | null //slots 的代理对象。

  /**
   * used for keeping track of .once event handlers on components
   * @internal
   */
  emitted: Record<string, boolean> | null //用于跟踪在组件上触发的 .once 事件处理器。
  /**
   * used for caching the value returned from props default factory functions to
   * avoid unnecessary watcher trigger
   * @internal
   */
  propsDefaults: Data // 用于缓存从 props 默认工厂函数返回的值，以避免不必要的监视器触发。
  /**
   * setup related
   * @internal
   */
  setupState: Data //组件通过 setup 函数返回的状态对象。
  /**
   * devtools access to additional info
   * @internal
   */
  devtoolsRawSetupState?: any //供开发工具访问的额外信息。
  /**
   * @internal
   */
  setupContext: SetupContext | null //setup 函数的上下文对象。

  /**
   * suspense related
   * @internal
   */
  suspense: SuspenseBoundary | null //组件是否与 Suspense 边界关联。
  /**
   * suspense pending batch id
   * @internal
   */
  suspenseId: number //Suspense 的待处理批处理 ID
  /**
   * @internal
   */
  asyncDep: Promise<any> | null //异步依赖，表示组件在异步依赖完成前是挂起状态
  /**
   * @internal
   */
  asyncResolved: boolean //组件的异步依赖是否已解决

  // lifecycle
  isMounted: boolean //组件是否已挂载。
  isUnmounted: boolean //组件是否已卸载。
  isDeactivated: boolean //组件是否已停用。
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_CREATE]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.CREATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_MOUNT]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.MOUNTED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_UPDATE]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.UPDATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.BEFORE_UNMOUNT]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.UNMOUNTED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.RENDER_TRACKED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.RENDER_TRIGGERED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.ACTIVATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.DEACTIVATED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.ERROR_CAPTURED]: LifecycleHook
  /**
   * @internal
   */
  [LifecycleHooks.SERVER_PREFETCH]: LifecycleHook<() => Promise<unknown>>

  /**
   * For caching bound $forceUpdate on public proxy access
   * @internal
   */
  f?: () => void //用于缓存绑定的 $forceUpdate 方法。
  /**
   * For caching bound $nextTick on public proxy access
   * @internal
   */
  n?: () => Promise<void> //用于缓存绑定的 $nextTick 方法。
  /**
   * `updateTeleportCssVars`
   * For updating css vars on contained teleports
   * @internal
   */
  ut?: (vars?: Record<string, string>) => void //用于更新包含 teleport 的 CSS 变量。
}

const emptyAppContext = createAppContext()

let uid = 0

export function createComponentInstance(
  vnode: VNode,
  parent: ComponentInternalInstance | null,
  suspense: SuspenseBoundary | null,
) {
  const type = vnode.type as ConcreteComponent
  // inherit parent app context - or - if root, adopt from root vnode
  const appContext =
    (parent ? parent.appContext : vnode.appContext) || emptyAppContext

  // 定义的组件（ConcreteComponent）--> 创建虚拟Dom（VNode，包含了context） --> 创建组件实例（包含type/vnode）
  //在 Vue 3 的源码中，ComponentInternalInstance 是用于描述组件实例的内部状态和上下文的对象。
  //它包含了与组件生命周期、渲染、依赖关系等相关的各种属性。这些属性在组件的创建、更新、销毁等过程中起着关键作用。
  const instance: ComponentInternalInstance = {
    uid: uid++, // 组件的唯一标识 每个组件实例都会分配一个自增的唯一 ID，用于在调试和内部管理中区分不同的组件实例。
    vnode, // 虚拟dom 表示组件在虚拟 DOM 树中的位置和结构，包含了组件的类型、属性、子节点等信息。vnode 是组件渲染和更新的基础。
    type, // 用户定义的组件 包含了组件的选项，如 setup 函数、模板、数据、方法等。type 决定了组件的行为和渲染逻辑。
    parent, //当前组件的父组件实例。 用于形成组件的父子关系链，可以通过 parent 访问父组件实例。
    appContext, //全局的context上下文
    root: null!, // to be immediately set
    next: null, // 在组件更新过程中，存储新的 vnode，用于与当前的 vnode 进行对比和更新。
    subTree: null!, // 组件的子树，表示组件渲染的内容。存储当前组件的渲染结果，即组件的子元素。
    effect: null!, //该组件的副作用管理器  Vue 的响应式系统通过 effect 来跟踪和管理组件的副作用（如渲染）
    // 更新函数，负责重新渲染组件。 当响应式数据发生变化时，update 函数会触发重新渲染。
    update: null!, // will be set synchronously right after creation
    // 组件的 EffectScope 实例。用于管理响应式副作用的生命周期，确保在组件卸载时可以正确清理。
    scope: new EffectScope(true /* detached */),
    // 组件的渲染函数。负责生成组件的虚拟 DOM 树。如果使用模板，则由编译器生成；如果使用 render 选项，则是用户自定义的渲染函数。
    render: null,
    proxy: null, // 组件实例的代理对象。 通过代理对象拦截对组件实例的属性访问，支持响应式和各种其他特性。
    exposed: null, //组件通过 expose 暴露给外部的对象。 可以在 setup 中通过 expose 手动指定组件实例公开的 API。
    exposeProxy: null, //代理暴露的对象。 为 expose 的对象提供代理，增强其行为
    withProxy: null, //用于模板编译的代理对象。 在模板中使用时，可以代理 setupState、props 等以优化性能。
    // 用于依赖注入的 provide 数据。组件实例的 provide 数据，供子组件通过 inject 使用。
    provides: parent ? parent.provides : Object.create(appContext.provides),
    accessCache: null!, //用于缓存访问的类型。优化属性访问时的性能，通过缓存减少不必要的计算。
    // 渲染函数的缓存。用于缓存渲染过程中产生的结果，以提高性能。
    renderCache: [],

    // local resolved assets
    components: null,
    directives: null,

    // resolved props and emits options
    //存储组件定义的 props 相关配置。
    propsOptions: normalizePropsOptions(type, appContext),
    // 存储组件定义的自定义事件配置
    emitsOptions: normalizeEmitsOptions(type, appContext),

    // emit
    emit: null!, // to be set immediately
    // 记录已经触发的事件。
    emitted: null,

    // props default value
    // 用于缓存 props 的默认值，以优化性能。
    propsDefaults: EMPTY_OBJ,

    // inheritAttrs
    // 决定组件是否会将未声明的属性作为 attrs 继承到根元素。
    inheritAttrs: type.inheritAttrs,

    // state
    ctx: EMPTY_OBJ, //组件的上下文对象。存储组件内部的响应式数据和方法。
    data: EMPTY_OBJ, // 用于存储组件的状态数据。
    props: EMPTY_OBJ,
    attrs: EMPTY_OBJ, //存储传递给组件但未被声明为 props 的属性。
    slots: EMPTY_OBJ,
    refs: EMPTY_OBJ,
    setupState: EMPTY_OBJ, //存储 setup 函数返回的响应式状态和方法。
    setupContext: null, //setup 函数的上下文对象。 提供 attrs、slots 和 emit 给 setup 函数使用。

    attrsProxy: null, //为 attrs 提供代理以优化性能。
    slotsProxy: null, //为 slots 提供代理以优化性能。

    // suspense related
    suspense, //组件的 Suspense 实例。用于异步组件加载的控制。
    suspenseId: suspense ? suspense.pendingId : 0, //Suspense 实例的 ID。用于区分不同的异步加载操作。
    // 异步依赖 在异步组件的加载过程中存储异步依赖。
    asyncDep: null,
    // 异步依赖是否已解析。标识组件的异步依赖是否已经被解析完成。
    asyncResolved: false,

    // lifecycle hooks
    // not using enums here because it results in computed properties
    isMounted: false,
    isUnmounted: false,
    isDeactivated: false,
    /**
     * bc、c、bm、m、bu、u、um、bum、da、a、rtg、rtc、ec、sp
     * 各个生命周期钩子函数，如 beforeCreate、created、beforeMount、mounted 等。
     * 用于管理组件生命周期中的各种操作。
     */
    bc: null,
    c: null,
    bm: null,
    m: null,
    bu: null,
    u: null,
    um: null,
    bum: null,
    da: null,
    a: null,
    rtg: null,
    rtc: null,
    ec: null,
    sp: null,
  }
  // 将组件实例本身作为ctx字段的值存储起来
  if (__DEV__) {
    instance.ctx = createDevRenderContext(instance)
  } else {
    instance.ctx = { _: instance }
  }
  instance.root = parent ? parent.root : instance
  instance.emit = emit.bind(null, instance)

  // apply custom element special handling
  if (vnode.ce) {
    vnode.ce(instance)
  }

  return instance
}

export let currentInstance: ComponentInternalInstance | null = null

export const getCurrentInstance: () => ComponentInternalInstance | null = () =>
  currentInstance || currentRenderingInstance

let internalSetCurrentInstance: (
  instance: ComponentInternalInstance | null,
) => void
let setInSSRSetupState: (state: boolean) => void

/**
 * The following makes getCurrentInstance() usage across multiple copies of Vue
 * work. Some cases of how this can happen are summarized in #7590. In principle
 * the duplication should be avoided, but in practice there are often cases
 * where the user is unable to resolve on their own, especially in complicated
 * SSR setups.
 *
 * Note this fix is technically incomplete, as we still rely on other singletons
 * for effectScope and global reactive dependency maps. However, it does make
 * some of the most common cases work. It also warns if the duplication is
 * found during browser execution.
 */
if (__SSR__) {
  type Setter = (v: any) => void
  const g = getGlobalThis()
  const registerGlobalSetter = (key: string, setter: Setter) => {
    let setters: Setter[]
    if (!(setters = g[key])) setters = g[key] = []
    setters.push(setter)
    return (v: any) => {
      if (setters.length > 1) setters.forEach(set => set(v))
      else setters[0](v)
    }
  }
  internalSetCurrentInstance = registerGlobalSetter(
    `__VUE_INSTANCE_SETTERS__`,
    v => (currentInstance = v),
  )
  // also make `isInSSRComponentSetup` sharable across copies of Vue.
  // this is needed in the SFC playground when SSRing async components, since
  // we have to load both the runtime and the server-renderer from CDNs, they
  // contain duplicated copies of Vue runtime code.
  setInSSRSetupState = registerGlobalSetter(
    `__VUE_SSR_SETTERS__`,
    v => (isInSSRComponentSetup = v),
  )
} else {
  internalSetCurrentInstance = i => {
    currentInstance = i
  }
  setInSSRSetupState = v => {
    isInSSRComponentSetup = v
  }
}

export const setCurrentInstance = (instance: ComponentInternalInstance) => {
  const prev = currentInstance
  internalSetCurrentInstance(instance)
  instance.scope.on()
  return () => {
    instance.scope.off()
    internalSetCurrentInstance(prev)
  }
}

export const unsetCurrentInstance = () => {
  currentInstance && currentInstance.scope.off()
  internalSetCurrentInstance(null)
}

const isBuiltInTag = /*#__PURE__*/ makeMap('slot,component')

export function validateComponentName(name: string, config: AppConfig) {
  const appIsNativeTag = config.isNativeTag || NO
  if (isBuiltInTag(name) || appIsNativeTag(name)) {
    warn(
      'Do not use built-in or reserved HTML elements as component id: ' + name,
    )
  }
}

export function isStatefulComponent(instance: ComponentInternalInstance) {
  return instance.vnode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT
}

export let isInSSRComponentSetup = false

export function setupComponent(
  instance: ComponentInternalInstance,
  isSSR = false,
) {
  isSSR && setInSSRSetupState(isSSR)

  const { props, children } = instance.vnode
  // 是否是一个有状态的组件
  const isStateful = isStatefulComponent(instance)
  initProps(instance, props, isStateful, isSSR)
  initSlots(instance, children)

  const setupResult = isStateful
    ? setupStatefulComponent(instance, isSSR)
    : undefined

  isSSR && setInSSRSetupState(false)
  return setupResult
}

function setupStatefulComponent(
  instance: ComponentInternalInstance,
  isSSR: boolean,
) {
  const Component = instance.type as ComponentOptions

  if (__DEV__) {
    if (Component.name) {
      validateComponentName(Component.name, instance.appContext.config)
    }
    if (Component.components) {
      const names = Object.keys(Component.components)
      for (let i = 0; i < names.length; i++) {
        validateComponentName(names[i], instance.appContext.config)
      }
    }
    if (Component.directives) {
      const names = Object.keys(Component.directives)
      for (let i = 0; i < names.length; i++) {
        validateDirectiveName(names[i])
      }
    }
    if (Component.compilerOptions && isRuntimeOnly()) {
      warn(
        `"compilerOptions" is only supported when using a build of Vue that ` +
          `includes the runtime compiler. Since you are using a runtime-only ` +
          `build, the options should be passed via your build tool config instead.`,
      )
    }
  }
  // 0. create render proxy property access cache
  // 组件的属性访问缓存
  instance.accessCache = Object.create(null)
  // 1. create public instance / render proxy
  // also mark it raw so it's never observed
  /**
   * 给ctx创建一个代理对象，并标识为非响应式，赋值给proxy字段
   * 代理的处理对象为PublicInstanceProxyHandlers
   */
  instance.proxy = markRaw(new Proxy(instance.ctx, PublicInstanceProxyHandlers))
  if (__DEV__) {
    exposePropsOnRenderContext(instance)
  }
  // 2. call setup()
  const { setup } = Component
  // 如果存在setup函数就调用setup函数
  if (setup) {
    const setupContext = (instance.setupContext =
      setup.length > 1 ? createSetupContext(instance) : null)

    // 在执行setup之前先设置当前组件，这样在setup里面就可以获取当前组件，并且在注册钩子函数中，可以知道是给哪个组件注册的
    const reset = setCurrentInstance(instance)
    pauseTracking()
    const setupResult = callWithErrorHandling(
      setup,
      instance,
      ErrorCodes.SETUP_FUNCTION,
      [
        __DEV__ ? shallowReadonly(instance.props) : instance.props,
        setupContext,
      ],
    )
    resetTracking()
    reset()

    if (isPromise(setupResult)) {
      setupResult.then(unsetCurrentInstance, unsetCurrentInstance)
      if (isSSR) {
        // return the promise so server-renderer can wait on it
        return setupResult
          .then((resolvedResult: unknown) => {
            handleSetupResult(instance, resolvedResult, isSSR)
          })
          .catch(e => {
            handleError(e, instance, ErrorCodes.SETUP_FUNCTION)
          })
      } else if (__FEATURE_SUSPENSE__) {
        // async setup returned Promise.
        // bail here and wait for re-entry.
        instance.asyncDep = setupResult
        if (__DEV__ && !instance.suspense) {
          const name = Component.name ?? 'Anonymous'
          warn(
            `Component <${name}>: setup function returned a promise, but no ` +
              `<Suspense> boundary was found in the parent component tree. ` +
              `A component with async setup() must be nested in a <Suspense> ` +
              `in order to be rendered.`,
          )
        }
      } else if (__DEV__) {
        // setup函数中不支持返回promise
        warn(
          `setup() returned a Promise, but the version of Vue you are using ` +
            `does not support it yet.`,
        )
      }
    } else {
      handleSetupResult(instance, setupResult, isSSR)
    }
  } else {
    // 生成render函数
    finishComponentSetup(instance, isSSR)
  }
}

export function handleSetupResult(
  instance: ComponentInternalInstance,
  setupResult: unknown,
  isSSR: boolean,
) {
  if (isFunction(setupResult)) {
    // setup returned an inline render function
    if (__SSR__ && (instance.type as ComponentOptions).__ssrInlineRender) {
      // when the function's name is `ssrRender` (compiled by SFC inline mode),
      // set it as ssrRender instead.
      instance.ssrRender = setupResult
    } else {
      // 如果setup返回一个function，则作为一个render函数
      instance.render = setupResult as InternalRenderFunction
    }
  } else if (isObject(setupResult)) {
    if (__DEV__ && isVNode(setupResult)) {
      warn(
        `setup() should not return VNodes directly - ` +
          `return a render function instead.`,
      )
    }
    // setup returned bindings.
    // assuming a render function compiled from template is present.
    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      instance.devtoolsRawSetupState = setupResult
    }
    // 将返回的对象封装成Proxy，浅层响应对象，如果返回的对象属性里面有ref对象，会自动解封，所以在模板中使用变量是不需要.value的，设置值也不需要.value
    // setup中返回的对象会自动处理ref中的.value
    instance.setupState = proxyRefs(setupResult)
    if (__DEV__) {
      exposeSetupStateOnRenderContext(instance)
    }
  } else if (__DEV__ && setupResult !== undefined) {
    warn(
      `setup() should return an object. Received: ${
        setupResult === null ? 'null' : typeof setupResult
      }`,
    )
  }
  finishComponentSetup(instance, isSSR)
}

type CompileFunction = (
  template: string | object,
  options?: CompilerOptions,
) => InternalRenderFunction

let compile: CompileFunction | undefined
let installWithProxy: (i: ComponentInternalInstance) => void

/**
 * For runtime-dom to register the compiler.
 * Note the exported method uses any to avoid d.ts relying on the compiler types.
 */
export function registerRuntimeCompiler(_compile: any) {
  compile = _compile
  installWithProxy = i => {
    // 这行代码检查了组件实例 i 的 render 函数是否有 _rc 属性。这个 _rc 属性通常是由编译器设置的，用来标识这个渲染函数是由模板编译而来的。
    if (i.render!._rc) {
      i.withProxy = new Proxy(i.ctx, RuntimeCompiledPublicInstanceProxyHandlers)
    }
  }
}

// dev only
export const isRuntimeOnly = () => !compile

/**
 * 先执行组件的setup方法，然后判断组件是否有render函数，如果没有render函数，通过template构建render函数
 *
 */
export function finishComponentSetup(
  instance: ComponentInternalInstance,
  isSSR: boolean,
  skipOptions?: boolean,
) {
  const Component = instance.type as ComponentOptions

  if (__COMPAT__) {
    convertLegacyRenderFn(instance)

    if (__DEV__ && Component.compatConfig) {
      validateCompatConfig(Component.compatConfig)
    }
  }

  // template / render function normalization
  // could be already set when returned from setup()
  // 如果setup中返回了function，直接作为renderH函数，否则从template中去解析
  if (!instance.render) {
    // only do on-the-fly compile if not in SSR - SSR on-the-fly compilation
    // is done by server-renderer
    if (!isSSR && compile && !Component.render) {
      const template =
        (__COMPAT__ &&
          instance.vnode.props &&
          instance.vnode.props['inline-template']) ||
        Component.template ||
        resolveMergedOptions(instance).template
      if (template) {
        if (__DEV__) {
          startMeasure(instance, `compile`)
        }
        const { isCustomElement, compilerOptions } = instance.appContext.config
        const { delimiters, compilerOptions: componentCompilerOptions } =
          Component
        const finalCompilerOptions: CompilerOptions = extend(
          extend(
            {
              isCustomElement,
              delimiters,
            },
            compilerOptions,
          ),
          componentCompilerOptions,
        )
        if (__COMPAT__) {
          // pass runtime compat config into the compiler
          finalCompilerOptions.compatConfig = Object.create(globalCompatConfig)
          if (Component.compatConfig) {
            // @ts-expect-error types are not compatible
            extend(finalCompilerOptions.compatConfig, Component.compatConfig)
          }
        }
        /**
         * 生成render渲染函数
         * 如果template是dom元素，就取dom元素的innerHtml
         * 如果是dom元素的id，就取该dom元素的innerHtml
         * 最后生成render函数
         */
        Component.render = compile(template, finalCompilerOptions)
        if (__DEV__) {
          endMeasure(instance, `compile`)
        }
      }
    }

    instance.render = (Component.render || NOOP) as InternalRenderFunction

    // for runtime-compiled render functions using `with` blocks, the render
    // proxy used needs a different `has` handler which is more performant and
    // also only allows a whitelist of globals to fallthrough.
    if (installWithProxy) {
      installWithProxy(instance)
    }
  }

  // support for 2.x options
  if (__FEATURE_OPTIONS_API__ && !(__COMPAT__ && skipOptions)) {
    const reset = setCurrentInstance(instance)
    pauseTracking()
    try {
      applyOptions(instance)
    } finally {
      resetTracking()
      reset()
    }
  }

  // warn missing template/render
  // the runtime compilation of template in SSR is done by server-render
  if (__DEV__ && !Component.render && instance.render === NOOP && !isSSR) {
    /* istanbul ignore if */
    if (!compile && Component.template) {
      warn(
        `Component provided template option but ` +
          `runtime compilation is not supported in this build of Vue.` +
          (__ESM_BUNDLER__
            ? ` Configure your bundler to alias "vue" to "vue/dist/vue.esm-bundler.js".`
            : __ESM_BROWSER__
              ? ` Use "vue.esm-browser.js" instead.`
              : __GLOBAL__
                ? ` Use "vue.global.js" instead.`
                : ``) /* should not happen */,
      )
    } else {
      warn(`Component is missing template or render function.`)
    }
  }
}

function getAttrsProxy(instance: ComponentInternalInstance): Data {
  return (
    instance.attrsProxy ||
    (instance.attrsProxy = new Proxy(
      instance.attrs,
      __DEV__
        ? {
            get(target, key: string) {
              markAttrsAccessed()
              track(instance, TrackOpTypes.GET, '$attrs')
              return target[key]
            },
            set() {
              warn(`setupContext.attrs is readonly.`)
              return false
            },
            deleteProperty() {
              warn(`setupContext.attrs is readonly.`)
              return false
            },
          }
        : {
            get(target, key: string) {
              track(instance, TrackOpTypes.GET, '$attrs')
              return target[key]
            },
          },
    ))
  )
}

/**
 * Dev-only
 */
function getSlotsProxy(instance: ComponentInternalInstance): Slots {
  return (
    instance.slotsProxy ||
    (instance.slotsProxy = new Proxy(instance.slots, {
      get(target, key: string) {
        track(instance, TrackOpTypes.GET, '$slots')
        return target[key]
      },
    }))
  )
}

export function createSetupContext(
  instance: ComponentInternalInstance,
): SetupContext {
  const expose: SetupContext['expose'] = exposed => {
    if (__DEV__) {
      if (instance.exposed) {
        warn(`expose() should be called only once per setup().`)
      }
      if (exposed != null) {
        let exposedType: string = typeof exposed
        if (exposedType === 'object') {
          if (isArray(exposed)) {
            exposedType = 'array'
          } else if (isRef(exposed)) {
            exposedType = 'ref'
          }
        }
        if (exposedType !== 'object') {
          warn(
            `expose() should be passed a plain object, received ${exposedType}.`,
          )
        }
      }
    }
    instance.exposed = exposed || {}
  }

  if (__DEV__) {
    // We use getters in dev in case libs like test-utils overwrite instance
    // properties (overwrites should not be done in prod)
    return Object.freeze({
      get attrs() {
        return getAttrsProxy(instance)
      },
      get slots() {
        return getSlotsProxy(instance)
      },
      get emit() {
        return (event: string, ...args: any[]) => instance.emit(event, ...args)
      },
      expose,
    })
  } else {
    return {
      get attrs() {
        return getAttrsProxy(instance)
      },
      slots: instance.slots,
      emit: instance.emit,
      expose,
    }
  }
}

export function getExposeProxy(instance: ComponentInternalInstance) {
  if (instance.exposed) {
    return (
      instance.exposeProxy ||
      (instance.exposeProxy = new Proxy(proxyRefs(markRaw(instance.exposed)), {
        get(target, key: string) {
          if (key in target) {
            return target[key]
          } else if (key in publicPropertiesMap) {
            return publicPropertiesMap[key](instance)
          }
        },
        has(target, key: string) {
          return key in target || key in publicPropertiesMap
        },
      }))
    )
  }
}

const classifyRE = /(?:^|[-_])(\w)/g
const classify = (str: string): string =>
  str.replace(classifyRE, c => c.toUpperCase()).replace(/[-_]/g, '')

export function getComponentName(
  Component: ConcreteComponent,
  includeInferred = true,
): string | false | undefined {
  return isFunction(Component)
    ? Component.displayName || Component.name
    : Component.name || (includeInferred && Component.__name)
}

/* istanbul ignore next */
export function formatComponentName(
  instance: ComponentInternalInstance | null,
  Component: ConcreteComponent,
  isRoot = false,
): string {
  let name = getComponentName(Component)
  if (!name && Component.__file) {
    const match = Component.__file.match(/([^/\\]+)\.\w+$/)
    if (match) {
      name = match[1]
    }
  }

  if (!name && instance && instance.parent) {
    // try to infer the name based on reverse resolution
    const inferFromRegistry = (registry: Record<string, any> | undefined) => {
      for (const key in registry) {
        if (registry[key] === Component) {
          return key
        }
      }
    }
    name =
      inferFromRegistry(
        instance.components ||
          (instance.parent.type as ComponentOptions).components,
      ) || inferFromRegistry(instance.appContext.components)
  }

  return name ? classify(name) : isRoot ? `App` : `Anonymous`
}

export function isClassComponent(value: unknown): value is ClassComponent {
  return isFunction(value) && '__vccOpts' in value
}
