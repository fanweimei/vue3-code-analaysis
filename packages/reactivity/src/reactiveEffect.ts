import { isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared'
import { DirtyLevels, type TrackOpTypes, TriggerOpTypes } from './constants'
import { type Dep, createDep } from './dep'
import {
  activeEffect,
  pauseScheduling,
  resetScheduling,
  shouldTrack,
  trackEffect,
  triggerEffects,
} from './effect'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Maps to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<object, KeyToDepMap>()

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

/**
 * Tracks access to a reactive property.
 *
 * This will check which effect is running at the moment and record it as dep
 * which records all effects that depend on the reactive property.
 *
 * @param target - Object holding the reactive property.
 * @param type - Defines the type of access to the reactive property.
 * @param key - Identifier of the reactive property to track.
 */
/**
 * 有三层：
 * 所有的响应对象target构成一个WeapMap
 * 简单地说，WeakMap 对 key 是弱引用，不影响垃圾回收器的工作。据这个特性可知，一旦 key 被垃圾回收器回收，那么对应的键和值就访问不到了。所以 WeakMap 经常用于存储那些只有当 key 所引用的对象存在时（没有被回收）才有价值的信息，例如上面的场景中，如果 target 对象没有任何引用了，说明用户侧不再需要它了，这时垃圾回收器会完成回收任务。但如果使用 Map 来代替WeakMap，那么即使用户侧的代码对 target 没有任何引用，这个 target 也不会被回收，最终可能导致内存溢出。
 * 单个响应对象中所有key构成一个map
 * 单个key对应的是Dep对象，但是Dep也是一个包含cleanup方法的map
 * 
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  /**
   * 判断activeEffect：只要当前执行的环境是在副作用函数中才需要去手机
   * 判断shouldTrack：比如对于数组，调用push方法，会先获取length（get操作获取length），再往数组中添加元素（set操作）。
   * 如下场景：两个副作用之间会进入一个互相触发执行的死循环的，所以对于像push方法，应该shouldTrack标识为false，这样就不会去进行副作用的依赖收集，本质上push是改变数组的值，也不需要去track依赖
   * effect(() => {
        observed.push(1)
      });
      effect(() => {
          observed.push(2)
      })
   */
  if (shouldTrack && activeEffect) {
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = createDep(() => depsMap!.delete(key))))
    }
    trackEffect(
      activeEffect,
      dep,
      __DEV__
        ? {
            target,
            type,
            key,
          }
        : void 0,
    )
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.
 *
 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>,
) {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  let deps: (Dep | undefined)[] = []
  /**
   * map和set对象中clear方法调用，所有元素都被清空了，所有元素对应的副作用都需要执行
   */
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    /**
     * for in 会在ownKeys方法中track收集length的依赖；
     * for of内部会先获取length，所以会在get中收集length的依赖
     * 
     * 这样的场景：直接改变数组的长度，除了触发length（for in/for of）的依赖副作用之外，还有超出设置长度的那些元素也会触发依赖（相当于超出长度的那些元素被删除了）
     * const observed = reactive([1,2,3]);
      effect(() => {
          for(let key of observed) {
              console.log(key)
          }
      });
      setTimeout(() => {
          observed.length = 2;
      }, 1000)
     */
    const newLength = Number(newValue)
    depsMap.forEach((dep, key) => {
      if (key === 'length' || (!isSymbol(key) && key >= newLength)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      /**
       * 对象添加属性、数组添加元素、Map的set方法执行、Set的add方法执行
       */
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          /**
           * ITERATE_KEY：
           *（1）普通对象的for in 
           * (2) Map和Set的size
           * (3) Map和Set的forEach
           * (4) Set和Map的迭代器（values/entries)
           * 
           * MAP_KEY_ITERATE_KEY：
           * （1）Map的迭代器方法keys
           */
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // 如果是数组，那么对应还需要触发length
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          /**
           * 原理同上
           * 不会去delete 一个数组的元素
           */
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        /**
         * 如果是Map，修改值的话，还需要触发对应的迭代器（values/entries/forEach）
         */
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  pauseScheduling()
  for (const dep of deps) {
    if (dep) {
      triggerEffects(
        dep,
        DirtyLevels.Dirty,
        __DEV__
          ? {
              target,
              type,
              key,
              newValue,
              oldValue,
              oldTarget,
            }
          : void 0,
      )
    }
  }
  resetScheduling()
}

export function getDepFromReactive(object: any, key: string | number | symbol) {
  return targetMap.get(object)?.get(key)
}
