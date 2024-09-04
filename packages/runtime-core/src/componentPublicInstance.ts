import {
  type ComponentInternalInstance,
  type Data,
  getExposeProxy,
  isStatefulComponent,
} from './component'
import { nextTick, queueJob } from './scheduler'
import {
  type WatchOptions,
  type WatchStopHandle,
  instanceWatch,
} from './apiWatch'
import {
  EMPTY_OBJ,
  type IfAny,
  NOOP,
  type Prettify,
  type UnionToIntersection,
  extend,
  hasOwn,
  isFunction,
  isGloballyAllowed,
  isString,
} from '@vue/shared'
import {
  type ShallowUnwrapRef,
  TrackOpTypes,
  type UnwrapNestedRefs,
  shallowReadonly,
  toRaw,
  track,
} from '@vue/reactivity'
import {
  type ComponentInjectOptions,
  type ComponentOptionsBase,
  type ComponentOptionsMixin,
  type ComputedOptions,
  type ExtractComputedReturns,
  type InjectToObject,
  type MergedComponentOptionsOverride,
  type MethodOptions,
  type OptionTypesKeys,
  type OptionTypesType,
  resolveMergedOptions,
  shouldCacheAccess,
} from './componentOptions'
import type { EmitFn, EmitsOptions } from './componentEmits'
import type { SlotsType, UnwrapSlotsType } from './componentSlots'
import { markAttrsAccessed } from './componentRenderUtils'
import { currentRenderingInstance } from './componentRenderContext'
import { warn } from './warning'
import { installCompatInstanceProperties } from './compat/instance'

/**
 * Custom properties added to component instances in any way and can be accessed through `this`
 *
 * @example
 * Here is an example of adding a property `$router` to every component instance:
 * ```ts
 * import { createApp } from 'vue'
 * import { Router, createRouter } from 'vue-router'
 *
 * declare module '@vue/runtime-core' {
 *   interface ComponentCustomProperties {
 *     $router: Router
 *   }
 * }
 *
 * // effectively adding the router to every component instance
 * const app = createApp({})
 * const router = createRouter()
 * app.config.globalProperties.$router = router
 *
 * const vm = app.mount('#app')
 * // we can access the router from the instance
 * vm.$router.push('/')
 * ```
 */
export interface ComponentCustomProperties {}

type IsDefaultMixinComponent<T> = T extends ComponentOptionsMixin
  ? ComponentOptionsMixin extends T
    ? true
    : false
  : false

type MixinToOptionTypes<T> =
  T extends ComponentOptionsBase<
    infer P,
    infer B,
    infer D,
    infer C,
    infer M,
    infer Mixin,
    infer Extends,
    any,
    any,
    infer Defaults,
    any,
    any,
    any
  >
    ? OptionTypesType<P & {}, B & {}, D & {}, C & {}, M & {}, Defaults & {}> &
        IntersectionMixin<Mixin> &
        IntersectionMixin<Extends>
    : never

// ExtractMixin(map type) is used to resolve circularly references
type ExtractMixin<T> = {
  Mixin: MixinToOptionTypes<T>
}[T extends ComponentOptionsMixin ? 'Mixin' : never]

export type IntersectionMixin<T> =
  IsDefaultMixinComponent<T> extends true
    ? OptionTypesType
    : UnionToIntersection<ExtractMixin<T>>

export type UnwrapMixinsType<
  T,
  Type extends OptionTypesKeys,
> = T extends OptionTypesType ? T[Type] : never

type EnsureNonVoid<T> = T extends void ? {} : T

export type ComponentPublicInstanceConstructor<
  T extends ComponentPublicInstance<
    Props,
    RawBindings,
    D,
    C,
    M
  > = ComponentPublicInstance<any>,
  Props = any,
  RawBindings = any,
  D = any,
  C extends ComputedOptions = ComputedOptions,
  M extends MethodOptions = MethodOptions,
> = {
  __isFragment?: never
  __isTeleport?: never
  __isSuspense?: never
  new (...args: any[]): T
}

export type CreateComponentPublicInstance<
  P = {},
  B = {},
  D = {},
  C extends ComputedOptions = {},
  M extends MethodOptions = {},
  Mixin extends ComponentOptionsMixin = ComponentOptionsMixin,
  Extends extends ComponentOptionsMixin = ComponentOptionsMixin,
  E extends EmitsOptions = {},
  PublicProps = P,
  Defaults = {},
  MakeDefaultsOptional extends boolean = false,
  I extends ComponentInjectOptions = {},
  S extends SlotsType = {},
  PublicMixin = IntersectionMixin<Mixin> & IntersectionMixin<Extends>,
  PublicP = UnwrapMixinsType<PublicMixin, 'P'> & EnsureNonVoid<P>,
  PublicB = UnwrapMixinsType<PublicMixin, 'B'> & EnsureNonVoid<B>,
  PublicD = UnwrapMixinsType<PublicMixin, 'D'> & EnsureNonVoid<D>,
  PublicC extends ComputedOptions = UnwrapMixinsType<PublicMixin, 'C'> &
    EnsureNonVoid<C>,
  PublicM extends MethodOptions = UnwrapMixinsType<PublicMixin, 'M'> &
    EnsureNonVoid<M>,
  PublicDefaults = UnwrapMixinsType<PublicMixin, 'Defaults'> &
    EnsureNonVoid<Defaults>,
> = ComponentPublicInstance<
  PublicP,
  PublicB,
  PublicD,
  PublicC,
  PublicM,
  E,
  PublicProps,
  PublicDefaults,
  MakeDefaultsOptional,
  ComponentOptionsBase<
    P,
    B,
    D,
    C,
    M,
    Mixin,
    Extends,
    E,
    string,
    Defaults,
    {},
    string,
    S
  >,
  I,
  S
>
// public properties exposed on the proxy, which is used as the render context
// in templates (as `this` in the render option)
export type ComponentPublicInstance<
  P = {}, // props type extracted from props option
  B = {}, // raw bindings returned from setup()
  D = {}, // return from data()
  C extends ComputedOptions = {},
  M extends MethodOptions = {},
  E extends EmitsOptions = {},
  PublicProps = P,
  Defaults = {},
  MakeDefaultsOptional extends boolean = false,
  Options = ComponentOptionsBase<any, any, any, any, any, any, any, any, any>,
  I extends ComponentInjectOptions = {},
  S extends SlotsType = {},
> = {
  $: ComponentInternalInstance
  $data: D
  $props: MakeDefaultsOptional extends true
    ? Partial<Defaults> & Omit<Prettify<P> & PublicProps, keyof Defaults>
    : Prettify<P> & PublicProps
  $attrs: Data
  $refs: Data
  $slots: UnwrapSlotsType<S>
  $root: ComponentPublicInstance | null
  $parent: ComponentPublicInstance | null
  $emit: EmitFn<E>
  $el: any
  $options: Options & MergedComponentOptionsOverride
  $forceUpdate: () => void
  $nextTick: typeof nextTick
  $watch<T extends string | ((...args: any) => any)>(
    source: T,
    cb: T extends (...args: any) => infer R
      ? (...args: [R, R]) => any
      : (...args: any) => any,
    options?: WatchOptions,
  ): WatchStopHandle
} & IfAny<P, P, Omit<P, keyof ShallowUnwrapRef<B>>> &
  ShallowUnwrapRef<B> &
  UnwrapNestedRefs<D> &
  ExtractComputedReturns<C> &
  M &
  ComponentCustomProperties &
  InjectToObject<I>

export type PublicPropertiesMap = Record<
  string,
  (i: ComponentInternalInstance) => any
>

/**
 * #2437 In Vue 3, functional components do not have a public instance proxy but
 * they exist in the internal parent chain. For code that relies on traversing
 * public $parent chains, skip functional ones and go to the parent instead.
 */
const getPublicInstance = (
  i: ComponentInternalInstance | null,
): ComponentPublicInstance | ComponentInternalInstance['exposed'] | null => {
  if (!i) return null
  if (isStatefulComponent(i)) return getExposeProxy(i) || i.proxy
  return getPublicInstance(i.parent)
}

export const publicPropertiesMap: PublicPropertiesMap =
  // Move PURE marker to new line to workaround compiler discarding it
  // due to type annotation
  /*#__PURE__*/ extend(Object.create(null), {
    $: i => i,
    $el: i => i.vnode.el,
    $data: i => i.data,
    $props: i => (__DEV__ ? shallowReadonly(i.props) : i.props),
    $attrs: i => (__DEV__ ? shallowReadonly(i.attrs) : i.attrs),
    $slots: i => (__DEV__ ? shallowReadonly(i.slots) : i.slots),
    $refs: i => (__DEV__ ? shallowReadonly(i.refs) : i.refs),
    $parent: i => getPublicInstance(i.parent),
    $root: i => getPublicInstance(i.root),
    $emit: i => i.emit,
    $options: i => (__FEATURE_OPTIONS_API__ ? resolveMergedOptions(i) : i.type),
    $forceUpdate: i =>
      i.f ||
      (i.f = () => {
        i.effect.dirty = true
        queueJob(i.update)
      }),
    $nextTick: i => i.n || (i.n = nextTick.bind(i.proxy!)),
    $watch: i => (__FEATURE_OPTIONS_API__ ? instanceWatch.bind(i) : NOOP),
  } as PublicPropertiesMap)

if (__COMPAT__) {
  installCompatInstanceProperties(publicPropertiesMap)
}

enum AccessTypes {
  OTHER,
  SETUP,
  DATA,
  PROPS,
  CONTEXT,
}

export interface ComponentRenderContext {
  [key: string]: any
  _: ComponentInternalInstance
}

export const isReservedPrefix = (key: string) => key === '_' || key === '$'

const hasSetupBinding = (state: Data, key: string) =>
  state !== EMPTY_OBJ && !state.__isScriptSetup && hasOwn(state, key)

// 这块代码待解析
/**
 * 这段代码定义了 PublicInstanceProxyHandlers 和 RuntimeCompiledPublicInstanceProxyHandlers 两个代理处理器，
 * 这些处理器是 Vue 3 中用于管理组件实例上下文 (ctx) 的关键部分。它们通过拦截属性访问、设置、检查属性是否存在等操作，来增强组件的行为。
 */
export const PublicInstanceProxyHandlers: ProxyHandler<any> = {
  get({ _: instance }: ComponentRenderContext, key: string) {
    const { ctx, setupState, data, props, accessCache, type, appContext } =
      instance

    // for internal formatters to know that this is a Vue instance
    if (__DEV__ && key === '__isVue') {
      return true
    }

    // data / props / ctx
    // This getter gets called for every property access on the render context
    // during render and is a major hotspot. The most expensive part of this
    // is the multiple hasOwn() calls. It's much faster to do a simple property
    // access on a plain object, so we use an accessCache object (with null
    // prototype) to memoize what access type a key corresponds to.
    let normalizedProps
    if (key[0] !== '$') {
      // 通过 accessCache 来缓存属性访问类型，以减少后续访问的开销。
      const n = accessCache![key]
      if (n !== undefined) {
        switch (n) {
          case AccessTypes.SETUP:
            return setupState[key]
          case AccessTypes.DATA:
            return data[key]
          case AccessTypes.CONTEXT:
            return ctx[key]
          case AccessTypes.PROPS:
            return props![key]
          // default: just fallthrough
        }
      } else if (hasSetupBinding(setupState, key)) {
        accessCache![key] = AccessTypes.SETUP
        return setupState[key]
      } else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
        accessCache![key] = AccessTypes.DATA
        return data[key]
      } else if (
        // only cache other properties when instance has declared (thus stable)
        // props
        (normalizedProps = instance.propsOptions[0]) &&
        hasOwn(normalizedProps, key)
      ) {
        accessCache![key] = AccessTypes.PROPS
        return props![key]
      } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
        accessCache![key] = AccessTypes.CONTEXT
        return ctx[key]
      } else if (!__FEATURE_OPTIONS_API__ || shouldCacheAccess) {
        accessCache![key] = AccessTypes.OTHER
      }
    }

    const publicGetter = publicPropertiesMap[key]
    let cssModule, globalProperties
    // public $xxx properties
    if (publicGetter) {
      // 公共属性：检查 publicPropertiesMap 中是否有对应的公共 $ 开头的属性，如 $attrs、$slots 等，并进行特殊处理。
      if (key === '$attrs') {
        track(instance, TrackOpTypes.GET, key)
        __DEV__ && markAttrsAccessed()
      } else if (__DEV__ && key === '$slots') {
        track(instance, TrackOpTypes.GET, key)
      }
      return publicGetter(instance)
    } else if (
      // css module (injected by vue-loader)
      // CSS 模块：如果使用了 vue-loader 注入的 CSS 模块，返回对应的样式值。
      (cssModule = type.__cssModules) &&
      (cssModule = cssModule[key])
    ) {
      return cssModule
    } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
      // user may set custom properties to `this` that start with `$`
      accessCache![key] = AccessTypes.CONTEXT
      return ctx[key]
    } else if (
      // global properties
      // 如果属性在全局配置 appContext.config.globalProperties 中存在，返回该属性。
      ((globalProperties = appContext.config.globalProperties),
      hasOwn(globalProperties, key))
    ) {
      if (__COMPAT__) {
        const desc = Object.getOwnPropertyDescriptor(globalProperties, key)!
        if (desc.get) {
          return desc.get.call(instance.proxy)
        } else {
          const val = globalProperties[key]
          return isFunction(val)
            ? Object.assign(val.bind(instance.proxy), val)
            : val
        }
      } else {
        return globalProperties[key]
      }
    } else if (
      __DEV__ &&
      currentRenderingInstance &&
      (!isString(key) ||
        // #1091 avoid internal isRef/isVNode checks on component instance leading
        // to infinite warning loop
        key.indexOf('__v') !== 0)
    ) {
      if (data !== EMPTY_OBJ && isReservedPrefix(key[0]) && hasOwn(data, key)) {
        warn(
          `Property ${JSON.stringify(
            key,
          )} must be accessed via $data because it starts with a reserved ` +
            `character ("$" or "_") and is not proxied on the render context.`,
        )
      } else if (instance === currentRenderingInstance) {
        warn(
          `Property ${JSON.stringify(key)} was accessed during render ` +
            `but is not defined on instance.`,
        )
      }
    }
  },

  set(
    { _: instance }: ComponentRenderContext,
    key: string,
    value: any,
  ): boolean {
    const { data, setupState, ctx } = instance
    // setupState：如果属性在 setupState 中存在，则直接设置值
    if (hasSetupBinding(setupState, key)) {
      setupState[key] = value
      return true
    } else if (
      __DEV__ &&
      setupState.__isScriptSetup &&
      hasOwn(setupState, key)
    ) {
      // 如果属性是 <script setup> 中定义的绑定，会在开发环境中发出警告并阻止修改。
      warn(`Cannot mutate <script setup> binding "${key}" from Options API.`)
      return false
    } else if (data !== EMPTY_OBJ && hasOwn(data, key)) {
      // data：如果属性在 data 中存在，直接更新 data 中的值。
      data[key] = value
      return true
    } else if (hasOwn(instance.props, key)) {
      // 防止修改 props：如果试图修改 props，会在开发环境中发出警告，因为 props 是只读的。
      __DEV__ && warn(`Attempting to mutate prop "${key}". Props are readonly.`)
      return false
    }
    if (key[0] === '$' && key.slice(1) in instance) {
      // $ 开头属性：防止修改 $ 开头的公共属性
      __DEV__ &&
        warn(
          `Attempting to mutate public property "${key}". ` +
            `Properties starting with $ are reserved and readonly.`,
        )
      return false
    } else {
      // 默认处理：如果属性不在上述任何部分，则尝试在 ctx 中设置属性
      if (__DEV__ && key in instance.appContext.config.globalProperties) {
        Object.defineProperty(ctx, key, {
          enumerable: true,
          configurable: true,
          value,
        })
      } else {
        ctx[key] = value
      }
    }
    return true
  },

  has(
    {
      _: { data, setupState, accessCache, ctx, appContext, propsOptions },
    }: ComponentRenderContext,
    key: string,
  ) {
    //依次检查：accessCache、data、setupState、props、ctx、publicPropertiesMap、appContext.config.globalProperties 中是否存在该属性。
    let normalizedProps
    return (
      !!accessCache![key] ||
      (data !== EMPTY_OBJ && hasOwn(data, key)) ||
      hasSetupBinding(setupState, key) ||
      ((normalizedProps = propsOptions[0]) && hasOwn(normalizedProps, key)) ||
      hasOwn(ctx, key) ||
      hasOwn(publicPropertiesMap, key) ||
      hasOwn(appContext.config.globalProperties, key)
    )
  },

  defineProperty(
    target: ComponentRenderContext,
    key: string,
    descriptor: PropertyDescriptor,
  ) {
    // 缓存清理：如果属性描述符包含 get 方法，清除缓存
    if (descriptor.get != null) {
      // invalidate key cache of a getter based property #5417
      target._.accessCache![key] = 0
    } else if (hasOwn(descriptor, 'value')) {
      // 属性设置：如果描述符中包含 value，则通过 set 捕获器进行设置。
      this.set!(target, key, descriptor.value, null)
    }
    return Reflect.defineProperty(target, key, descriptor)
  },
}

if (__DEV__ && !__TEST__) {
  PublicInstanceProxyHandlers.ownKeys = (target: ComponentRenderContext) => {
    warn(
      `Avoid app logic that relies on enumerating keys on a component instance. ` +
        `The keys will be empty in production mode to avoid performance overhead.`,
    )
    return Reflect.ownKeys(target)
  }
}

// RuntimeCompiledPublicInstanceProxyHandlers 是在 PublicInstanceProxyHandlers 的基础上扩展而来的，它添加了一些特殊处理，以支持运行时编译的组件实例。
/**
 * 在 Vue 3 中，"运行时编译"（Runtime Compilation）指的是在应用程序运行时，动态地将模板字符串编译成渲染函数的过程。
 * 这与"预编译"（Ahead-of-Time Compilation, AOT）相对应，后者是在构建时将模板编译为渲染函数。
 * 
 * 模板编译：
 * Vue 的模板语言是一种类似 HTML 的语法，它允许你声明式地描述 UI。为了将这种模板转换成 JavaScript 渲染函数（即如何在浏览器中构建和更新 DOM 的函数），Vue 需要一个编译过程。
  渲染函数可以直接操作虚拟 DOM，从而生成最终的 UI。
 * 预编译：
 * 通常情况下，在开发过程中，Vue 的模板会在构建阶段（使用工具如 Vue CLI）被编译为渲染函数。这种预编译方式更高效，因为在运行时不需要再进行编译，直接执行渲染函数就可以生成 UI。
    预编译的优点是可以减小包体积并提高性能。

    场景：
    内容管理系统 (CMS)：允许用户输入和编辑 HTML 模板，系统需要在前端动态渲染这些模板。
    动态组件：在应用中根据某些条件动态生成模板并渲染。
    开发环境：在开发过程中实时编辑模板，并立即看到效果。

    总结：
    Vue 3 中的运行时编译是一种在应用运行时动态将模板字符串编译成渲染函数的机制。它为开发者提供了灵活性，允许处理动态模板，但相对预编译模式，它需要牺牲一些性能和包体积。
 */
export const RuntimeCompiledPublicInstanceProxyHandlers = /*#__PURE__*/ extend(
  {},
  PublicInstanceProxyHandlers,
  {
    /**
     * 快速路径：如果属性是 Symbol.unscopables，直接返回 undefined，这是为了处理 with 语句块中的快速路径。
     * 委托：将其他的属性访问操作委托给 PublicInstanceProxyHandlers 的 get 方法。
     */
    get(target: ComponentRenderContext, key: string) {
      // fast path for unscopables when using `with` block
      if ((key as any) === Symbol.unscopables) {
        return
      }
      return PublicInstanceProxyHandlers.get!(target, key, target)
    },
    // 特殊处理：对于以 _ 开头的属性，或者不在全局允许范围内的属性，会在开发环境中发出警告。
    has(_: ComponentRenderContext, key: string) {
      const has = key[0] !== '_' && !isGloballyAllowed(key)
      if (__DEV__ && !has && PublicInstanceProxyHandlers.has!(_, key)) {
        warn(
          `Property ${JSON.stringify(
            key,
          )} should not start with _ which is a reserved prefix for Vue internals.`,
        )
      }
      return has
    },
  },
)

// dev only
// In dev mode, the proxy target exposes the same properties as seen on `this`
// for easier console inspection. In prod mode it will be an empty object so
// these properties definitions can be skipped.
export function createDevRenderContext(instance: ComponentInternalInstance) {
  const target: Record<string, any> = {}

  // expose internal instance for proxy handlers
  Object.defineProperty(target, `_`, {
    configurable: true,
    enumerable: false,
    get: () => instance,
  })

  // expose public properties
  Object.keys(publicPropertiesMap).forEach(key => {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      get: () => publicPropertiesMap[key](instance),
      // intercepted by the proxy so no need for implementation,
      // but needed to prevent set errors
      set: NOOP,
    })
  })

  return target as ComponentRenderContext
}

// dev only
export function exposePropsOnRenderContext(
  instance: ComponentInternalInstance,
) {
  const {
    ctx,
    propsOptions: [propsOptions],
  } = instance
  if (propsOptions) {
    Object.keys(propsOptions).forEach(key => {
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => instance.props[key],
        set: NOOP,
      })
    })
  }
}

// dev only
export function exposeSetupStateOnRenderContext(
  instance: ComponentInternalInstance,
) {
  const { ctx, setupState } = instance
  Object.keys(toRaw(setupState)).forEach(key => {
    // 不是在script上setup的，那么返回的值放入ctx中
    if (!setupState.__isScriptSetup) {
      if (isReservedPrefix(key[0])) {
        warn(
          `setup() return property ${JSON.stringify(
            key,
          )} should not start with "$" or "_" ` +
            `which are reserved prefixes for Vue internals.`,
        )
        return
      }
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => setupState[key],
        set: NOOP,
      })
    }
  })
}
