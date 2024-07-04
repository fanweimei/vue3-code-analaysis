import { NOOP, extend } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import {
  DirtyLevels,
  type TrackOpTypes,
  type TriggerOpTypes,
} from './constants'
import type { Dep } from './dep'
import { type EffectScope, recordEffectScope } from './effectScope'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export let activeEffect: ReactiveEffect | undefined

// 副作用函数
export class ReactiveEffect<T = any> {
  active = true
  /**
   * 多对多的关系，一个副作用函数可以包含多个依赖的响应对象，一个响应对象可以存在多个副作用函数中
   */
  deps: Dep[] = []

  /**
   * Can be attached after creation
   * @internal
   */
  computed?: ComputedRefImpl<T>
  /**
   * @internal
   */
  allowRecurse?: boolean

  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  /**
   * @internal
   */
  _dirtyLevel = DirtyLevels.Dirty
  /**
   * @internal
   */
  _trackId = 0
  /**
   * @internal
   */
  _runnings = 0
  /**
   * @internal
   */
  _shouldSchedule = false
  /**
   * @internal
   */
  _depsLength = 0

  constructor(
    public fn: () => T,
    public trigger: () => void,
    public scheduler?: EffectScheduler,
    scope?: EffectScope,
  ) {
    recordEffectScope(this, scope)
  }

  public get dirty() {
    if (this._dirtyLevel === DirtyLevels.MaybeDirty) {
      pauseTracking()
      for (let i = 0; i < this._depsLength; i++) {
        const dep = this.deps[i]
        if (dep.computed) {
          triggerComputed(dep.computed)
          if (this._dirtyLevel >= DirtyLevels.Dirty) {
            break
          }
        }
      }
      if (this._dirtyLevel < DirtyLevels.Dirty) {
        this._dirtyLevel = DirtyLevels.NotDirty
      }
      resetTracking()
    }
    return this._dirtyLevel >= DirtyLevels.Dirty
  }

  public set dirty(v) {
    this._dirtyLevel = v ? DirtyLevels.Dirty : DirtyLevels.NotDirty
  }

  // 1 last null active p1
  // 2 last p1 active p2
  // 3 last p2 active p3
  // p3执行完 active p2
  // p2环境 执行完 active p1
  // p3环境执行完
  /**
   * 总而言之：
   * 1. lastEffect和activeEffect是为了防止堆栈递归调用effect函数的情况；
   * 2. preCleanupEffect和postCleanupEffect结合_trackId目的就是为了每次执行前先斩断依赖对象和副作用函数之间的关系，
   * 执行之后再重新收集依赖关系，但是呢从性能上考虑清空的时候不是直接把deps数组长度清空，
   * 而是先通过_depsLength设置为0，重新建立正确的依赖关系，把多余的元素再剪短依赖关系
   * 3. _trackId是副作用对象的执行次数追踪id
   */
  run() {
    this._dirtyLevel = DirtyLevels.NotDirty // 只要即将执行，就是标志为NotDirty，比如一些异步函数，如果等执行完，
    if (!this.active) {
      return this.fn()
    }
    let lastShouldTrack = shouldTrack
    let lastEffect = activeEffect
    try {
      shouldTrack = true
      activeEffect = this
      this._runnings++
      /**
       * 通过preCleaupEffect方法
       * 标识执行状态_trackId加1了，然后把_depsLength设置为零
       */
      preCleanupEffect(this);
      /**
       * 执行fn副作用函数的时候，会重新手机依赖对象
       * 收集的过程有多种情况：
       * （1）只是把Dep中的key对应的value（_trackId）更新，它们的依赖关系依赖没变
       * （2）存在有一些依赖对象没有执行到的，那这个时候deps里面的元素是比_depsLength要多
       */
      return this.fn()
    } finally {
      /**
       * 收集过程中，走到清空2，
       * 通过postCleanupEffect，把deps中多余的元素清空，并且见到多余的依赖对象和副作用函数之间的关系
       */
      postCleanupEffect(this)
      /**
       * _running的作用：
       * （1）如果一个副作用函数对一个key先有get,然后set操作，因为_running不为0，所以后面的set操作不会再次触发副作用函数的执行
       * （2）如果副作用函数是一个异步函数，在副作用函数还没执行结束之前，就发生了依赖对象key的改变，因为_running也不会再次触发副作用函数
       */
      this._runnings--
      activeEffect = lastEffect
      shouldTrack = lastShouldTrack
    }
  }

  stop() {
    if (this.active) {
      preCleanupEffect(this)
      postCleanupEffect(this)
      this.onStop?.()
      this.active = false
    }
  }
}

function triggerComputed(computed: ComputedRefImpl<any>) {
  return computed.value
}

function preCleanupEffect(effect: ReactiveEffect) {
  effect._trackId++
  effect._depsLength = 0
}

function postCleanupEffect(effect: ReactiveEffect) {
  if (effect.deps && effect.deps.length > effect._depsLength) {
    for (let i = effect._depsLength; i < effect.deps.length; i++) {
      cleanupDepEffect(effect.deps[i], effect)
    }
    effect.deps.length = effect._depsLength
  }
}

function cleanupDepEffect(dep: Dep, effect: ReactiveEffect) {
  const trackId = dep.get(effect)
   //这里判断原因
  /**
   * 比如说ok text name三个属性，
   * 第二次ok为true了，
   * text对应的代码不会再执行到了，name就占据到deps中的第二个位置，再执行postCleanupEffect方法时候
   * 第三个元素其实就是第二个元素，trackId是等于effect._trackId的
   */
  if (trackId !== undefined && effect._trackId !== trackId) {
    dep.delete(effect)
    if (dep.size === 0) {
      dep.cleanup()
    }
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

/**
 * Registers the given function to track reactive updates.
 *
 * The given function will be run once immediately. Every time any reactive
 * property that's accessed within it gets updated, the function will run again.
 *
 * @param fn - The function that will track reactive updates.
 * @param options - Allows to control the effect's behaviour.
 * @returns A runner that can be used to control the effect after creation.
 */
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner {
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const _effect = new ReactiveEffect(fn, NOOP, () => {
    if (_effect.dirty) {
      _effect.run()
    }
  })
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  if (!options || !options.lazy) {
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

export let shouldTrack = true
export let pauseScheduleStack = 0

const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

export function pauseScheduling() {
  pauseScheduleStack++
}

export function resetScheduling() {
  pauseScheduleStack--
  while (!pauseScheduleStack && queueEffectSchedulers.length) {
    queueEffectSchedulers.shift()!()
  }
}

export function trackEffect(
  effect: ReactiveEffect,
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo,
) {
  /**
   * 比如在一个副作用函数中两次及以上使用了同一个代理对象的key的值，那第二次进入的时候，因为已经存在了且_trackId是相同的，就不会重复添加
   * effect的_trackId的作用就是一个状态id，每执行一次，_trackId就加1，这样做目的：
   * 第一次执行副作用函数的时候，会记录所有依赖对象的deps，但是后面执行条件发生改变了，可能某些依赖对象根本不会执行到，所以每次执行副作用函数
   * 之前需要清空副作用函数对应的依赖对象，执行后又重新创建依赖对象，通过_depsLength和deps这样每次清空的时候，不会直接先把数组给清空了
   * 所以第二次执行的时候_trackId是已经改变了
   */
  if (dep.get(effect) !== effect._trackId) {
    dep.set(effect, effect._trackId)
    const oldDep = effect.deps[effect._depsLength]
    if (oldDep !== dep) {
      if (oldDep) {
        cleanupDepEffect(oldDep, effect)
      }
      effect.deps[effect._depsLength++] = dep
    } else {
      effect._depsLength++
    }
    if (__DEV__) {
      effect.onTrack?.(extend({ effect }, debuggerEventExtraInfo!))
    }
  }
}

const queueEffectSchedulers: EffectScheduler[] = []

/**
 * 比如一个副作用函数即引用了代理A对象p属性的值，又循环遍历代理对象A
 * 那么A对象p属性的值更改时，即会触发p属性对应的副作用，也会触发迭代器对应的副作用
 * 第一次_dirtyLevel是NotDirty，改为Dirty，然后把该副作用函数先计入副作用调度器队列里面
 * 第二次通过迭代器进入triggerEffects的时候，因为都是同一个副作用对象，因为lastDirtyLevel已经是Dirty，所以不会再进入if里面，
 * 避免重复执行，比如以下场景：
 * const observed = reactive([1,2,3]);
     effect(() => {
        console.log(observed[3]);
        for(let item of observed) {
            console.log(item);
        }
    });
    setTimeout(() => {
        observed[3] = 5;
    }, 500)
    属性值length和key为3都会对effect建立依赖关系，observed[3]改变的时候，length和3对应的effect都会执行，因为通过_dirtyLevel和队列的形式，副作用只会加入到队列中一次并只执行一次（队列的作用不仅仅只有这一个）。
 */
export function triggerEffects(
  dep: Dep,
  dirtyLevel: DirtyLevels,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo,
) {
  pauseScheduling()
  for (const effect of dep.keys()) {
    if (
      effect._dirtyLevel < dirtyLevel && // 上一次没有dirty，这一次dirty，如果上一次正在dirty中，说明上一次副作用函数还没执行完，每次执行副作用函数之前都会把dirty设置为notdirty
      dep.get(effect) === effect._trackId 
    ) {
      const lastDirtyLevel = effect._dirtyLevel
      effect._dirtyLevel = dirtyLevel
      if (lastDirtyLevel === DirtyLevels.NotDirty) {
        effect._shouldSchedule = true
        if (__DEV__) {
          effect.onTrigger?.(extend({ effect }, debuggerEventExtraInfo))
        }
        effect.trigger()
      }
    }
  }
  scheduleEffects(dep)
  resetScheduling()
}

/**
 * 如果一个副作用函数对某个key先get，再set，那么set触发trigger，进入这个函数，_runnings不为0，allowRecurse默认是false
 * 所以不会重新调用副作用函数，不然就有可能进入死循环
 */
export function scheduleEffects(dep: Dep) {
  for (const effect of dep.keys()) {
    if (
      effect.scheduler &&
      effect._shouldSchedule &&
      (!effect._runnings || effect.allowRecurse) &&
      dep.get(effect) === effect._trackId
    ) {
      effect._shouldSchedule = false
      queueEffectSchedulers.push(effect.scheduler)
    }
  }
}
