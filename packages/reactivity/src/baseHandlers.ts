import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import {
  pauseScheduling,
  pauseTracking,
  resetScheduling,
  resetTracking,
} from './effect'
import { ITERATE_KEY, track, trigger } from './reactiveEffect'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    /**
     * 在iOS10.x中，Object.getOwnPropertyNames(Symbol)可以枚举"arguments"和"caller"，但是Symbol对象上访问
     * 这些属性会导致TypeError，因为Symbol是一个严格模式函数
     */
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol),
)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      pauseTracking()
      pauseScheduling()
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetScheduling()
      resetTracking()
      return res
    }
  })
  return instrumentations
}

function hasOwnProperty(this: object, key: string) {
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key)
}

class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false,
    protected readonly _shallow = false,
  ) {}

  // 获取对象的属性值
  get(target: Target, key: string | symbol, receiver: object) {
    const isReadonly = this._isReadonly,
      shallow = this._shallow
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    } else if (key === ReactiveFlags.RAW) {
      // 判断receiver是否是target的代理对象，或者receiver和target被同一个对象代理了
      // 获取原始对象
      /**
       * 如下情况：
       * const { reactive, effect } = Vue;
        const o1 = {s: 'c'};
        const o2 = {id: 1, s: 'p'};
        const c = reactive(o1);
        const p = reactive(o2);
        Object.setPrototypeOf(c, p);
        effect(() => {
            console.log(c.id);
        }) 
        获取c.id的时候第一次进入child的get方法，发现没有id属性，然后就会进入parent的get方法，这个时候target是o2，但是receiver是c
       */
      if (
        receiver ===
          (isReadonly
            ? shallow
              ? shallowReadonlyMap
              : readonlyMap
            : shallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // receiver is not the reactive proxy, but has the same prototype
        // this means the reciever is a user proxy of the reactive proxy
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        return target
      }
      // early return undefined
      return
    }

    const targetIsArray = isArray(target)

    if (!isReadonly) {
      if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
        return Reflect.get(arrayInstrumentations, key, receiver)
      }
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }
    /**
     * target是原对象，
     * receiver是代理对象
     * 这里之所以使用Reflect
     * const obj = {
     *  id: 1,
     *  get uuid () {
     *    return this.id
     * }
     * }
     * const proxy = new Proxy(obj)
     * 方法proxy.uuid时，this始终指向代理对象
     */
    const res = Reflect.get(target, key, receiver)

    // 是否是哪些不被追踪的属性
    // 防止数组的[Symbol.iterator]被收集，for of遍历的时候会先调用[Symbol.iterator]，然后再获取内部的length，所以[Symbol.iterator]被忽略，值收集length的依赖，防止一个副作用函数被收集两次
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 只读对象不需要追踪依赖，对象的属性值是不会改变的，所以不需要追踪
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }
    // 如果是浅依赖的就直接返回，不需要再递归创建代理
    if (shallow) {
      return res
    }
    /**
     * 所以即使props中传入给子组件的值是ref也能正确取值，返回的是ref的value值
     */
    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(shallow = false) {
    super(false, shallow)
  }

  // 给对象添加属性值/或者给对象修改属性值
  set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    let oldValue = (target as any)[key]
    /**
     * 如果是浅层的，那么自然只有第一层，第二层都是原始对象了
     */
    if (!this._shallow) {
      // 原来key对应的值是响应式的，且只可读，则不允许设置
      /**
       * value可能本身就是oldvalue的代理对象，所以需要先把value原始的对象取出来，这样，再hasChanged比较的时候就不会有问题
       * 这种情况下，hasChanged应该是false，如果不这样操作，hasChanged就会变成true，
       * 反正在get方法的时候取出来会递归调用reactive，获取值的时候仍然是代理对象
       * let obj = {city: 'gz', address: 'panyu'};
        const d = reactive(obj);
        const person = reactive({id: 1, name: 'ff', d: obj});
        effect(() => {
            console.log(person.d) 
        })
        setTimeout(() => {
            person.d = d; //不会触发以上的effect
        }, 100)
       * 
       * 如果oldValue是元素对象，value是oldValue的可读的对象，那说明value是不会被track/trigger，value根本不会被改变，不用担心trigger
       * 如果是shallow，因为this._shallow已经是false，说明本身target创建的代理对象就是深度，而现在要给他复制shallowReactive，
       * 虽然对应的是同一个代理对象，但是属性值仍然是改变了的
       * let obj = {city: 'gz', address: 'panyu'};
          const d = shallowReactive(obj);
          const person = reactive({id: 1, name: 'ff', d: obj});
          effect(() => {
              console.log(person.d)
          })
          setTimeout(() => {
              person.d = d; // 会再次触发以上的effect
          }, 100)
       * 这里还有一个原因就是为了防止数据污染，比如有两个响应对象p1,p2，将p2设置成p1的某个属性值，
          const obj = {city: 'gz', address: 'panyu'};
          const p1 = reactive(obj);
          const p2 = reactive({});
          p1['p2'] = p2;
          effect(() => {
              console.log(obj.p2.id)
          });
          console.log(p1.p2, obj.p2)
          setTimeout(() => {
              obj.p2.id = 11;
          })
          如果不经过这样的操作，那么obj.p2对应的就是p2响应对象，那么obj.p2.id改变的时候就会触发effect执行，
          现在因为obj.p2是原始对象了，所以不会有这个数据污染问题
          （把响应式数据设置到原始数据上的行为称为样式污染
       */
      const isOldValueReadonly = isReadonly(oldValue)
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      // 如果对象的key值原来是ref，新的值不是ref，则将新的值赋值给原来key对应的值
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          return false
        } else {
          oldValue.value = value
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        // 如果是给对象新增加值，增加的值夜不是ref，则触发add
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 如果是修改原来的值，则触发set
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  // delete操作触发，比如 delete observed.foo
  deleteProperty(target: object, key: string | symbol): boolean {
    const hadKey = hasOwn(target, key)
    const oldValue = (target as any)[key]
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      // 存在这个key并且成功删除了，才会触发delete
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  // 'foo' in observed 触发的就是has函数
  has(target: object, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    /**
     * 这里为什么要排除symbol函数呢
     * 因为在for of循环遍历数组的时候，除了会触发length，还会触发symbol迭代器的方法，就会重复执行副作用函数
     * 所以for of循序只记录一个length的track就可以了
     */
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }
  /**
   * （1）for in 触发的就是ownKeys函数
   * （2）Object.keys(proxy)
   */
  ownKeys(target: object): (string | symbol)[] {
    // for in和 in会进入到这个方法，如果是数组，只要记录length改变就行了，
    /**
     * 比如一个副作用函数内for in一个数组，那么后面这个数组长度改变了，都应该触发这个副作用函数的执行
     * 如果是for in一个对象，那么这个对象的属性添加了或者减少了，都应该触发ITERATE_KEY，所以记录的也是ITERATE_KEY
     */
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    return Reflect.ownKeys(target)
  }
}

class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(shallow = false) {
    super(true, shallow)
  }

  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new MutableReactiveHandler()

export const readonlyHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers = /*#__PURE__*/ new MutableReactiveHandler(
  true,
)

// props handlers特殊之处在于它不应该解包顶层refs，但它仍然保持普通只读对象的响应性
export const shallowReadonlyHandlers =
  /*#__PURE__*/ new ReadonlyReactiveHandler(true)
