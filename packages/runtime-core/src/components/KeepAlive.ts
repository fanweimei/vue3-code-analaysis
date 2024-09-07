import {
  type ComponentInternalInstance,
  type ComponentOptions,
  type ConcreteComponent,
  type SetupContext,
  currentInstance,
  getComponentName,
  getCurrentInstance,
} from '../component'
import {
  type VNode,
  type VNodeProps,
  cloneVNode,
  invokeVNodeHook,
  isSameVNodeType,
  isVNode,
} from '../vnode'
import { warn } from '../warning'
import {
  injectHook,
  onBeforeUnmount,
  onMounted,
  onUnmounted,
  onUpdated,
} from '../apiLifecycle'
import {
  ShapeFlags,
  invokeArrayFns,
  isArray,
  isRegExp,
  isString,
  remove,
} from '@vue/shared'
import { watch } from '../apiWatch'
import {
  type ElementNamespace,
  MoveType,
  type RendererElement,
  type RendererInternals,
  type RendererNode,
  queuePostRenderEffect,
} from '../renderer'
import { setTransitionHooks } from './BaseTransition'
import type { ComponentRenderContext } from '../componentPublicInstance'
import { devtoolsComponentAdded } from '../devtools'
import { isAsyncWrapper } from '../apiAsyncComponent'
import { isSuspense } from './Suspense'
import { LifecycleHooks } from '../enums'

type MatchPattern = string | RegExp | (string | RegExp)[]

export interface KeepAliveProps {
  include?: MatchPattern
  exclude?: MatchPattern
  max?: number | string
}

type CacheKey = string | number | symbol | ConcreteComponent
type Cache = Map<CacheKey, VNode>
type Keys = Set<CacheKey>

export interface KeepAliveContext extends ComponentRenderContext {
  renderer: RendererInternals
  activate: (
    vnode: VNode,
    container: RendererElement,
    anchor: RendererNode | null,
    namespace: ElementNamespace,
    optimized: boolean,
  ) => void
  deactivate: (vnode: VNode) => void
}


export const isKeepAlive = (vnode: VNode): boolean =>
  (vnode.type as any).__isKeepAlive

const KeepAliveImpl: ComponentOptions = {
  name: `KeepAlive`,

  // Marker for special handling inside the renderer. We are not using a ===
  // check directly on KeepAlive in the renderer, because importing it directly
  // would prevent it from being tree-shaken.
  __isKeepAlive: true,

  props: {
    include: [String, RegExp, Array],
    exclude: [String, RegExp, Array],
    max: [String, Number],
  },

  setup(props: KeepAliveProps, { slots }: SetupContext) {
    const instance = getCurrentInstance()!
    // KeepAlive communicates with the instantiated renderer via the
    // ctx where the renderer passes in its internals,
    // and the KeepAlive instance exposes activate/deactivate implementations.
    // The whole point of this is to avoid importing KeepAlive directly in the
    // renderer to facilitate tree-shaking.
    const sharedContext = instance.ctx as KeepAliveContext

    // if the internal renderer is not registered, it indicates that this is server-side rendering,
    // for KeepAlive, we just need to render its children
    if (__SSR__ && !sharedContext.renderer) {
      return () => {
        const children = slots.default && slots.default()
        return children && children.length === 1 ? children[0] : children
      }
    }

    /**
     * 我们使用一个 Map 对象来实现对组件的缓存
     */
    const cache: Cache = new Map()
    const keys: Keys = new Set()
    // current表示当前keep-alive下正激活的组件，keep-alive下当前正显示的子组件
    let current: VNode | null = null

    if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
      ;(instance as any).__v_cache = cache
    }

    const parentSuspense = instance.suspense

    const {
      renderer: {
        p: patch,
        m: move,
        um: _unmount,
        o: { createElement },
      },
    } = sharedContext
    // 创建一个隐藏容器
    const storageContainer = createElement('div')

    sharedContext.activate = (
      vnode,
      container,
      anchor,
      namespace,
      optimized,
    ) => {
      const instance = vnode.component!
      //  而激活的本质是将组件所渲染的内容从隐藏容器中搬运回原来的容器
      move(vnode, container, anchor, MoveType.ENTER, parentSuspense)
      // in case props have changed
      patch(
        instance.vnode,
        vnode,
        container,
        anchor,
        instance,
        parentSuspense,
        namespace,
        vnode.slotScopeIds,
        optimized,
      )
      queuePostRenderEffect(() => {
        instance.isDeactivated = false
        // activated钩子函数 
        if (instance.a) {
          invokeArrayFns(instance.a)
        }
        const vnodeHook = vnode.props && vnode.props.onVnodeMounted
        if (vnodeHook) {
          invokeVNodeHook(vnodeHook, instance.parent, vnode)
        }
      }, parentSuspense)

      if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
        // Update components tree
        devtoolsComponentAdded(instance)
      }
    }

    sharedContext.deactivate = (vnode: VNode) => {
      const instance = vnode.component!
      // 失活的本质就是将组件所渲染的内容移动到隐藏容器中
      move(vnode, storageContainer, null, MoveType.LEAVE, parentSuspense)
      queuePostRenderEffect(() => {
        // deactivated钩子函数
        if (instance.da) {
          invokeArrayFns(instance.da)
        }
        const vnodeHook = vnode.props && vnode.props.onVnodeUnmounted
        if (vnodeHook) {
          invokeVNodeHook(vnodeHook, instance.parent, vnode)
        }
        instance.isDeactivated = true
      }, parentSuspense)

      if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
        // Update components tree
        devtoolsComponentAdded(instance)
      }
    }

    function unmount(vnode: VNode) {
      // reset the shapeFlag so it can be properly unmounted
      resetShapeFlag(vnode)
      _unmount(vnode, instance, parentSuspense, true)
    }

    function pruneCache(filter?: (name: string) => boolean) {
      cache.forEach((vnode, key) => {
        const name = getComponentName(vnode.type as ConcreteComponent)
        if (name && (!filter || !filter(name))) {
          pruneCacheEntry(key)
        }
      })
    }

    /**
     * 卸载组件：当缓存的组件实例已经不再与当前激活的组件对应时，需要卸载以释放资源。
      处理正在使用的组件：如果当前激活的组件实例仍在使用，但不需要继续作为缓存组件，则重置其标志，但暂时不卸载，可能在后续情况下处理。
      清理缓存：无论组件是否被卸载，都会从缓存记录中移除对应的键值，保持缓存的清洁。
     */
    function pruneCacheEntry(key: CacheKey) {
      const cached = cache.get(key) as VNode
      // 当前激活组件不存在或者不是当前激活的组件
      if (!current || !isSameVNodeType(cached, current)) {
        unmount(cached)
      } else if (current) {
        /**
         * 如果当前激活的组件 current 存在，并且与缓存的 cached 是相同类型的虚拟节点，但在某些场景下仍不希望该组件继续被保留为 KeepAlive 状态，那么此时不会直接卸载它，而是通过 resetShapeFlag(current) 重置当前组件的 shapeFlag，表示它可能将来不再作为 KeepAlive 组件进行管理。resetShapeFlag 的作用是重置组件的状态标志
         */
        // current active instance should no longer be kept-alive.
        // we can't unmount it now but it might be later, so reset its flag now.把标志位重置，这样后续的unmount中就会执行unmount
        resetShapeFlag(current)
      }
      cache.delete(key)
      keys.delete(key)
    }

    // prune cache on include/exclude prop change
    /**
     * 在默认情况下，KeepAlive 组件会对所有“内部组件”进行缓存。但
      有时候用户期望只缓存特定组件。为了使用户能够自定义缓存规则，
      我们需要让 KeepAlive 组件支持两个 props，分别是 include 和
      exclude
     */
    watch(
      () => [props.include, props.exclude],
      ([include, exclude]) => {
        include && pruneCache(name => matches(include, name))
        exclude && pruneCache(name => !matches(exclude, name))
      },
      // prune post-render after `current` has been updated
      { flush: 'post', deep: true },
    )

    // cache sub tree after render
    let pendingCacheKey: CacheKey | null = null
    const cacheSubtree = () => {
      // fix #1621, the pendingCacheKey could be 0
      // instance是keep-alive组件的实例，subTree就是子组件的返回的虚拟节点，cache就是key是子组件的type（或者key)，value就是子组件的虚拟节点
      if (pendingCacheKey != null) {
        cache.set(pendingCacheKey, getInnerChild(instance.subTree))
      }
    }
    onMounted(cacheSubtree)
    onUpdated(cacheSubtree)

    onBeforeUnmount(() => {
      cache.forEach(cached => {
        const { subTree, suspense } = instance
        const vnode = getInnerChild(subTree)
        // 卸载keep-alive之前先对当前组件的deactivated钩子进行调用，其它缓存的组件直接unmount，当前组件会在后续unmount卸载
        if (cached.type === vnode.type && cached.key === vnode.key) {
          // current instance will be unmounted as part of keep-alive's unmount
          resetShapeFlag(vnode)
          // but invoke its deactivated hook here
          // 只有当前显示的组件在卸载时，才会先执行deactivated钩子函数，再执行unmount动作
          const da = vnode.component!.da
          da && queuePostRenderEffect(da, suspense)
          return
        }
        unmount(cached)
      })
    })

    return () => {
      pendingCacheKey = null

      if (!slots.default) {
        return null
      }

      const children = slots.default()
      const rawVNode = children[0]
      // keep-alive下有且只有一个子节点，且子节点为配置型的组件
      if (children.length > 1) {
        if (__DEV__) {
          warn(`KeepAlive should contain exactly one component child.`)
        }
        current = null
        return children
      } else if (
        !isVNode(rawVNode) ||
        (!(rawVNode.shapeFlag & ShapeFlags.STATEFUL_COMPONENT) &&
          !(rawVNode.shapeFlag & ShapeFlags.SUSPENSE))
      ) {
        current = null
        return rawVNode
      }

      let vnode = getInnerChild(rawVNode)
      const comp = vnode.type as ConcreteComponent

      // for async components, name check should be based in its loaded
      // inner component if available
      // 获取组件的名字，如果是异步组件，则是获取被加载组件的名字
      const name = getComponentName(
        isAsyncWrapper(vnode)
          ? (vnode.type as ComponentOptions).__asyncResolved || {}
          : comp,
      )

      const { include, exclude, max } = props
      // 如果不在缓存列表中，则直接返回子组件渲染
      if (
        (include && (!name || !matches(include, name))) ||
        (exclude && name && matches(exclude, name))
      ) {
        current = vnode
        return rawVNode
      }
    
      /**
       * 这行代码用来确定缓存键。首先判断 vnode.key 是否为空，如果为空则使用组件 comp 作为 key，否则使用 vnode.key。这个 key 是用来在缓存中查找或存储虚拟 DOM (vnode) 的
       */
      const key = vnode.key == null ? comp : vnode.key
      const cachedVNode = cache.get(key)

      // clone vnode if it's reused because we are going to mutate it
      /**
       * 如果 vnode.el 存在，说明这个虚拟节点已经挂载（有对应的 DOM 元素），需要克隆该节点以避免直接修改已挂载的节点。这种克隆机制是为了保证数据不可变性。同时，如果节点有 Suspense 特性（用于异步组件加载），需要额外处理。
       */
      if (vnode.el) {
        vnode = cloneVNode(vnode)
        if (rawVNode.shapeFlag & ShapeFlags.SUSPENSE) {
          rawVNode.ssContent = vnode
        }
      }
      // #1513 it's possible for the returned vnode to be cloned due to attr
      // fallthrough or scopeId, so the vnode here may not be the final vnode
      // that is mounted. Instead of caching it directly, we store the pending
      // key and cache `instance.subTree` (the normalized vnode) in
      // beforeMount/beforeUpdate hooks.
      //把当前 key 赋值给 pendingCacheKey，记录下当前缓存键。
      pendingCacheKey = key

      if (cachedVNode) {
        /**
         * 如果 cachedVNode 存在，表示组件已缓存：

          把缓存的 DOM 元素和组件实例赋值给当前的 vnode。
          如果 vnode 有过渡动画，调用 setTransitionHooks 来递归更新过渡钩子。
          更新 vnode 的 shapeFlag，表示这个组件已被保留。
          最后，更新缓存键的顺序以表示其“最新”状态，删除最旧的键并将新的键加入。
         */
        // copy over mounted state
        vnode.el = cachedVNode.el
        vnode.component = cachedVNode.component
        if (vnode.transition) {
          // recursively update transition hooks on subTree
          setTransitionHooks(vnode, vnode.transition!)
        }
        // avoid vnode being mounted as fresh
        // 已经缓存过的组件，有COMPONENT_KEPT_ALIVE标志了，不执行mount了，而是执行ctx的activate
        vnode.shapeFlag |= ShapeFlags.COMPONENT_KEPT_ALIVE
        // make this key the freshest
        // 采用的修剪策略叫作“最新一次访问”
        keys.delete(key)
        keys.add(key)
      } else {
        keys.add(key)
        // prune oldest entry
        // 在加入新的缓存组件前，先判断缓存列表中keys是否已经达到了最大值，如果达到了则删除最旧的缓存组件
        /**
         * 采用的策略就是最新一次访问，
         * 通过设置一个Set对象(keys)，存放所有的key，
         * 最新加入的直接通过add方法添加到集合的最后
         * 访问已经存在的，先删除，再重新通过add添加到最后，
         * 如果加入新元素后超过最大值了，就通过keys.values().next().value获取最旧的值
         */
        if (max && keys.size > parseInt(max as string, 10)) {
          pruneCacheEntry(keys.values().next().value)
        }
      }
      // avoid vnode being unmounted
      //标志了COMPONENT_SHOULD_KEEP_ALIVE位，组件挂载成功后就执行激活钩子函数，在unmount中执行ctx的deactivate
      vnode.shapeFlag |= ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE

      current = vnode
      return isSuspense(rawVNode.type) ? rawVNode : vnode
    }
  },
}

if (__COMPAT__) {
  KeepAliveImpl.__isBuildIn = true
}

// export the public type for h/tsx inference
// also to avoid inline import() in generated d.ts files
export const KeepAlive = KeepAliveImpl as any as {
  __isKeepAlive: true
  new (): {
    $props: VNodeProps & KeepAliveProps
    $slots: {
      default(): VNode[]
    }
  }
}

function matches(pattern: MatchPattern, name: string): boolean {
  if (isArray(pattern)) {
    return pattern.some((p: string | RegExp) => matches(p, name))
  } else if (isString(pattern)) {
    return pattern.split(',').includes(name)
  } else if (isRegExp(pattern)) {
    return pattern.test(name)
  }
  /* istanbul ignore next */
  return false
}

export function onActivated(
  hook: Function,
  target?: ComponentInternalInstance | null,
) {
  registerKeepAliveHook(hook, LifecycleHooks.ACTIVATED, target)
}

export function onDeactivated(
  hook: Function,
  target?: ComponentInternalInstance | null,
) {
  registerKeepAliveHook(hook, LifecycleHooks.DEACTIVATED, target)
}

function registerKeepAliveHook(
  hook: Function & { __wdc?: Function },
  type: LifecycleHooks,
  target: ComponentInternalInstance | null = currentInstance,
) {
  // cache the deactivate branch check wrapper for injected hooks so the same
  // hook can be properly deduped by the scheduler. "__wdc" stands for "with
  // deactivation check".
  const wrappedHook =
    hook.__wdc ||
    (hook.__wdc = () => {
      // only fire the hook if the target instance is NOT in a deactivated branch.
      let current: ComponentInternalInstance | null = target
      while (current) {
        if (current.isDeactivated) {
          return
        }
        current = current.parent
      }
      return hook()
    })
  injectHook(type, wrappedHook, target)
  // In addition to registering it on the target instance, we walk up the parent
  // chain and register it on all ancestor instances that are keep-alive roots.
  // This avoids the need to walk the entire component tree when invoking these
  // hooks, and more importantly, avoids the need to track child components in
  // arrays.
  if (target) {
    let current = target.parent
    while (current && current.parent) {
      if (isKeepAlive(current.parent.vnode)) {
        injectToKeepAliveRoot(wrappedHook, type, target, current)
      }
      current = current.parent
    }
  }
}

function injectToKeepAliveRoot(
  hook: Function & { __weh?: Function },
  type: LifecycleHooks,
  target: ComponentInternalInstance,
  keepAliveRoot: ComponentInternalInstance,
) {
  // injectHook wraps the original for error handling, so make sure to remove
  // the wrapped version.
  const injected = injectHook(type, hook, keepAliveRoot, true /* prepend */)
  onUnmounted(() => {
    remove(keepAliveRoot[type]!, injected)
  }, target)
}

function resetShapeFlag(vnode: VNode) {
  // bitwise operations to remove keep alive flags
  vnode.shapeFlag &= ~ShapeFlags.COMPONENT_SHOULD_KEEP_ALIVE
  vnode.shapeFlag &= ~ShapeFlags.COMPONENT_KEPT_ALIVE
}

function getInnerChild(vnode: VNode) {
  return vnode.shapeFlag & ShapeFlags.SUSPENSE ? vnode.ssContent! : vnode
}
