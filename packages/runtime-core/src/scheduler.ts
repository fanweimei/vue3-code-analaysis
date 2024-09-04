import { ErrorCodes, callWithErrorHandling, handleError } from './errorHandling'
import { type Awaited, NOOP, isArray } from '@vue/shared'
import { type ComponentInternalInstance, getComponentName } from './component'

export interface SchedulerJob extends Function {
  id?: number //用于标识任务的唯一 ID。这个 ID 通常用于对任务进行排序或去重，以确保任务在队列中的唯一性或特定的执行顺序。
  pre?: boolean //表示该任务是否需要优先执行。在 Vue 的调度器中，有些任务需要在普通任务之前执行，比如某些生命周期钩子函数或 watch 的回调函数。
  active?: boolean //表示该任务是否处于活动状态。如果设置为 false，则该任务可能会被跳过或暂停执行。这在某些情况下用于控制任务的执行，比如暂停某个特定的任务。
  computed?: boolean //表示该任务是否是由 computed（计算属性）生成的。这用于区分不同类型的任务，因为计算属性有其特定的更新逻辑。
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   * 表示任务是否允许递归触发自身。在 Vue 的调度系统中，默认情况下任务是不能递归触发自身的，因为这可能会导致无限循环，尤其是在某些数组操作
   */
  allowRecurse?: boolean
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   * 由 renderer.ts 在设置组件的渲染效果时附加，用于获取组件的信息。这个属性通常用于开发模式下，在报告最大递归更新次数时使用。
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

let isFlushing = false //标识当前是否正在刷新队列。
let isFlushPending = false //标识是否有待处理的任务刷新请求。

const queue: SchedulerJob[] = [] //任务队列，所有待执行的任务都存储在这个数组中。
let flushIndex = 0 //当前正在处理的任务索引。
/**
 * 这是一个数组，用于存储待执行的后置回调函数（post-flush callbacks）。这些回调函数通常会在所有同步任务（如组件更新、DOM 操作等）完成之后再执行。
 在调度系统中，某些任务（如 watch 的回调函数，或者 nextTick 的回调函数）需要在组件更新完成后再执行。Vue 会把这些任务添加到 pendingPostFlushCbs 中，并在适当的时机一次性执行。
*/
const pendingPostFlushCbs: SchedulerJob[] = []
/**
 * 这是当前正在执行的后置回调任务的列表。它的初始值为 null，表示当前没有正在执行的后置回调任务。
 * 在执行 pendingPostFlushCbs 中的回调任务时，会将这些任务赋值给 activePostFlushCbs，表示这些任务正在被处理。这么做的目的是为了确保在回调函数执行时，不会再往 pendingPostFlushCbs 中添加新的任务，避免重复执行。
 */
let activePostFlushCbs: SchedulerJob[] | null = null
let postFlushIndex = 0

const resolvedPromise = /*#__PURE__*/ Promise.resolve() as Promise<any>
let currentFlushPromise: Promise<void> | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

export function nextTick<T = void, R = void>(
  this: T,
  fn?: (this: T) => R,
): Promise<Awaited<R>> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
function findInsertionIndex(id: number) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJob = queue[middle]
    const middleJobId = getId(middleJob)
    if (middleJobId < id || (middleJobId === id && middleJob.pre)) {
      start = middle + 1
    } else {
      end = middle
    }
  }

  return start
}

export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.
  if (
    !queue.length ||
    !queue.includes(
      job,
      isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex,
    )
  ) {
    if (job.id == null) {
      queue.push(job)
    } else {
      queue.splice(findInsertionIndex(job.id), 0, job)
    }
    queueFlush()
  }
}

function queueFlush() {
  if (!isFlushing && !isFlushPending) {
    isFlushPending = true
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

export function queuePostFlushCb(cb: SchedulerJobs) {
  if (!isArray(cb)) {
    if (
      !activePostFlushCbs ||
      !activePostFlushCbs.includes(
        cb,
        cb.allowRecurse ? postFlushIndex + 1 : postFlushIndex,
      )
    ) {
      pendingPostFlushCbs.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    pendingPostFlushCbs.push(...cb)
  }
  queueFlush()
}

export function flushPreFlushCbs(
  instance?: ComponentInternalInstance,
  seen?: CountMap,
  // if currently flushing, skip the current job itself
  i = isFlushing ? flushIndex + 1 : 0,
) {
  if (__DEV__) {
    seen = seen || new Map()
  }
  for (; i < queue.length; i++) {
    const cb = queue[i]
    if (cb && cb.pre) {
      if (instance && cb.id !== instance.uid) {
        continue
      }
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      queue.splice(i, 1)
      i--
      cb()
    }
  }
}

/**
 *在 Vue 的调度系统中，后置回调函数通常是在所有同步任务（例如 DOM 更新）执行完成后才被触发。以下是后置回调执行的简化流程：

收集回调任务：在某些情况下（例如 watch 的回调、nextTick 等），会将回调任务添加到 pendingPostFlushCbs 中。

触发执行：当所有同步任务执行完成后，Vue 会调用一个函数（如 flushPostFlushCbs）来处理 pendingPostFlushCbs 中的所有任务。

执行回调任务：

将 pendingPostFlushCbs 中的任务复制到 activePostFlushCbs 中，并清空 pendingPostFlushCbs。
逐个执行 activePostFlushCbs 中的任务，并使用 postFlushIndex 追踪当前执行的位置。
执行完成后，重置 postFlushIndex 和 activePostFlushCbs。
 */

export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {
    const deduped = [...new Set(pendingPostFlushCbs)].sort(
      (a, b) => getId(a) - getId(b),
    )
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

const comparator = (a: SchedulerJob, b: SchedulerJob): number => {
  const diff = getId(a) - getId(b)
  if (diff === 0) {
    if (a.pre && !b.pre) return -1
    if (b.pre && !a.pre) return 1
  }
  return diff
}

function flushJobs(seen?: CountMap) {
  isFlushPending = false
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  queue.sort(comparator)

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {
          continue
        }
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    flushIndex = 0
    queue.length = 0

    flushPostFlushCbs(seen)

    isFlushing = false
    currentFlushPromise = null
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      handleError(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`,
        null,
        ErrorCodes.APP_ERROR_HANDLER,
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
