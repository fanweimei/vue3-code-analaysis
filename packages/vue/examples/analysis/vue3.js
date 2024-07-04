const bucket = new WeakMap();

let activeEffect;
const effectStack = [];
const ITERATE_KEY = Symbol();
const TriggerType = {
	SET: 'SET',
	ADD: 'ADD',
	DELETE: 'DELETE'
}
let shouldTrack = true;

function hasChanged(oldVal, newVal) {
	if (oldVal !== newVal && (oldVal === oldVal && newVal === newVal)) {
		return true;
	}
	return false;
}
const arrayInstrumentations = {};
;['includes', 'indexOf', 'lastIndexOf'].forEach(method => {
	const originMethod = Array.prototype[method];
	arrayInstrumentations[method] = function (...args) {
		let res = originMethod.apply(this, args);
		if(res === false || res === -1) {
			res = originMethod.apply(this.raw, args);
		}
		return res;
	}
});
;['push', 'pop', 'shift', 'unshift', 'splice'].forEach(method => {
	const originMethod = Array.prototype[method];
	arrayInstrumentations[method] = function(...args) {
		shouldTrack = false;
		let res = originMethod.apply(this, args);
		shouldTrack = true;
		return res;
	}
})

function cleanup(effectFn) {
	for (let i = 0; i < effectFn.deps.length; i++) {
		const deps = effectFn.deps[i];
		deps.delete(effectFn);
	}
	effectFn.deps.length = 0;
}

function effect(fn, options = {}) {
	const effectFn = () => {
		cleanup(effectFn);
		activeEffect = effectFn;
		effectStack.push(effectFn);
		const res = fn();
		effectStack.pop();
		activeEffect = effectStack.length ? effectStack[effectStack.length - 1] : undefined;
		console.log('effect...')
		return res;
	}
	effectFn.deps = [];
	effectFn.options = options;
	if (!options.lazy) {
		effectFn();
	}
	return effectFn;
}

function track(target, key) {
	if (!activeEffect || !shouldTrack) {
		return;
	}
	let depsMap = bucket.get(target);
	if (!depsMap) {
		bucket.set(target, (depsMap = new Map()))
	}
	let deps = depsMap.get(key);
	if (!deps) {
		depsMap.set(key, (deps = new Set()))
	}
	deps.add(activeEffect);
	activeEffect.deps.push(deps);
}

function trigger(target, key, type) {
	const depsMap = bucket.get(target);
	if (!depsMap) {
		return;
	}
	const effects = depsMap.get(key);
	const effectsToRuns = new Set(effects);
	if (type == TriggerType.ADD || type == TriggerType.DELETE) {
		const iterateEffects = depsMap.get(ITERATE_KEY);
		if (iterateEffects) {
			iterateEffects.forEach(item => effectsToRuns.add(item));
		}
	}
	effectsToRuns && effectsToRuns.forEach(fn => {
		if (fn === activeEffect) {
			return;
		}
		if (fn.options.scheduler) {
			fn.options.scheduler(fn);
		} else {
			fn();
		}
	})
}

// computed
function computed(getter) {
	let value, dirty = true;
	const effectFn = effect(getter, {
		lazy: true,
		scheduler: () => {
			dirty = true;
			trigger(obj, 'value')
		}
	});
	const obj = {
		get value() {
			if (dirty) {
				value = effectFn();
				dirty = false;
			}
			track(obj, 'value')
			return value;
		}
	}
	return obj;
}

// watch
function traverse(value, seen = new Set()) {
	if (typeof value !== 'object' || value === null || seen.has(value)) {
		return;
	}
	seen.add(value);
	for (let key in value) {
		traverse(value[key], seen);
	}
	return value;
}

function watch(source, cb, options = {}) {
	let getter
	if (typeof source === 'function') {
		getter = source;
	} else {
		getter = () => traverse(source)
	}
	let oldVal, newVal;
	let cleanup;

	function onInvalidate(fn) {
		cleanup = fn;
	}

	const effectFn = effect(() => getter(), {
		lazy: true,
		scheduler: () => {
			if (options.flush == 'post') {
				Promise.resolve().then(() => {
					job()
				})
			} else {
				job();
			}
		}
	});

	function job() {
		newVal = effectFn()
		if (cleanup) {
			cleanup();
		}
		cb(newVal, oldVal, onInvalidate);
		oldVal = newVal;
	}
	if (options.immediate) {
		job();
	} else {
		oldVal = effectFn();
	}
}

function createReactive(o, isShallow = false, isReadonly = false) {
	return new Proxy(o, {
		get(target, key, receiver) {
			console.log('get--', key)
			if(key === 'raw') {
				return target;
			}
			if(Array.isArray(target) && arrayInstrumentations.hasOwnProperty(key)) {
				return Reflect.get(arrayInstrumentations, key, receiver);
			}
			if(!isReadonly && typeof key !== 'symbol') {
				track(target, key);
			}
			const res = Reflect.get(target, key, receiver);
			if(isShallow) {
				return res;
			}
			if(typeof res === 'object' && res !== null) {
				if(isReadonly) {
					return isReadonly(o)
				} else {
					return reactive(res);
				}
			}
			return res;
		},
		set(target, key, newVal, receiver) {
			console.log('set---', key);
			if(isReadonly) {
				console.warn(`属性${key}是只读的`);
				return true;
			}
			const oldVal = target[key];
			const type = Object.prototype.hasOwnProperty.call(target, key) ? TriggerType.SET : TriggerType
				.ADD;
			Reflect.set(target, key, newVal, receiver);
			if(receiver.raw === target) {
				if (hasChanged(oldVal, newVal)) {
					trigger(target, key, type);
				}
			}
			return true;
		},
		deleteProperty(target, key, receiver) {
			if(isReadonly) {
				console.warn(`属性${key}是只读的`);
				return true;
			}
			const hadKey = Object.prototype.hasOwnProperty.call(target, key);
			const res = Reflect.deleteProperty(target, key, receiver);
			if (hadKey && res) {
				trigger(target, key, TriggerType.DELETE);
			}
			return res;
		},
		has(target, key, receiver) {
			if(!isReadonly) {
				track(target, key);
			}
			console.log('has ', key)
			return Reflect.has(target, key, receiver);
		},
		ownKeys(target, receiver) {
			if(!isReadonly) {
				track(target, Array.isArray(target) ? 'length' : ITERATE_KEY);
			}
			console.log('track iterate')
			return Reflect.ownKeys(target);
		}
	});
}
const reactiveMap = new Map();

function reactive(o) {
	const existProxy = reactiveMap.get(o);
	if(existProxy) {
		return existProxy;
	}
	const proxy = createReactive(o);
	reactiveMap.set(o, proxy);
	return proxy;
}
function shallowReactive(o) {
	return createReactive(o, true);
}
function readonly(o) {
	return createReactive(o, false, true);
}
function shallowReadonly(o) {
	return createReactive(o, true, true);
}

const m = new Map([['id', 1]]);
const p = reactive(m);
effect(() => {
	console.log(p.get('id'))
});
setTimeout(() => {
	p.set('id', 2)
}, 1000);

// 验证在副作用函数中执行push/pop等操作，不应该被track，不应该有track的行为，是修改数组本身的值，而不是获取
// push/pop操作的时候都会先获取length，然后重新设置length，所以这里追踪要屏蔽
// const arr = reactive([]);
// effect(() => {
// 	arr.push(1);
// 	console.log('11111')
// });

// setTimeout(() => {
// 	arr.length = 2;
// }, 1000)

// 验证includes/indexOf
// const obj = {};
// const arr = reactive([obj]);

// effect(() => {
// 	console.log(arr.includes(obj))
// });
// setTimeout(() => {
// 	arr[0] = 3;
// }, 1000)
// console.log(arr)

// const obj = reactive({foo: {bar: 1}});
// effect(() => {
// 	console.log(obj.foo.bar)
// });

// setTimeout(() => {
// 	obj.foo.bar = 2;
// }, 1000)

// 验证raw
// const obj = {};
// const proto = { bar: 1 };
// const child = reactive(obj);
// const parent = reactive(proto);
// Object.setPrototypeOf(child, parent);

// effect(() => {
// 	// child -- bar 
// 	// parent --- bar 
// 	console.log(child.bar)
// });

// setTimeout(() => {
// 	child.bar = 2;
// }, 1000);

// 验证hasChanged
// const data = {
// 	text: 'hello world',
// 	ok: true,
// 	bar: 'bar',
// 	foo: 'foo',
// 	id: 0,
// 	get fbar() {
// 		// console.log(this)
// 		return this.bar;
// 	},
// 	n: NaN
// };

// const obj = reactive(data);

// 	effect(() => {
// 		console.log(obj.n);
// 	});

// setTimeout(() => {
// 	obj.n = NaN;
// }, 1000)

// 验证for in /in /delete
// effect(() => {
// 	for(let key in obj) {
// 		console.log(key);
// 	}
// });

// setTimeout(() => {
// 	delete obj.id;
// }, 1000)

// 验证computed
// const cres = computed(() => {
// 	return obj.foo + obj.bar
// });

// effect(() => {
// 	console.log('effect---cres:', cres.value)
// })
// setTimeout(() => {
// 	obj.bar = 'yoyo '
// }, 1000)


/**
 * 情景一：分支切换与cleanup
 */
// effect(() => {
// 	document.body.innerHTML = obj.ok ? obj.text : 'not'
// 	console.log('excute')
// })
// setTimeout(() => {
// 	obj.ok = false;
// }, 2000)

// setTimeout(() => {
// 	obj.text = 'haha'
// }, 3000)

/**
 * 情景二：嵌套的effect与effect栈
 */
// effect(function effectFn1() {
// 	console.log('effectFn1 执行')
// 	effect(function effectFn2() {
// 		console.log('effectFn2执行');
// 		temp2 = obj.bar
// 	});
// 	temp1 = obj.foo
// })

// setTimeout(() => {
// 	obj.foo = 'hello foo'
// }, 3000)

/**
 * 情景三：避免无线递归循环
 * 解决办法并不难。通过分析这个问题我们能够发现，读取和设置操作是在同一个副作用函数内进行的。
 * 此时无论是 track 时收集的副作用函数，还是 trigger 时要触发执行的副作用函数，都是activeEffect。
 * 基于此，我们可以在 trigger 动作发生时增加守卫条件：如果 trigger 触发执行的副作用函数与当前正在执行的副作用函数相同，则不触发执行
 */
// effect(() => {
// 	obj.id++;
// 	console.log(obj.id)
// })

/**
 * 情景四：调度器
 */
// effect(() => {
// 	console.log(obj.id)
// }, {
// 	scheduler: (fn) => {
// 		setTimeout(() => {
// 			fn();
// 		}, 0)
// 	}
// })
// obj.id++;
// console.log('over--')

// 任务队列
// const jobQueque = new Set();
// const p = Promise.resolve();
// let isFlushing = false;
// function flushJob() {
// 	console.log(222)
// 	if(isFlushing) {
// 		return;
// 	}
// 	console.log(333)
// 	isFlushing = true;
// 	p.then(() => {
// 		console.log(jobQueque.size, 999)
// 		jobQueque.forEach(job => {
// 			job();
// 		})
// 	}).finally(() => {
// 		isFlushing = false;
// 	});
// }

// effect(() => {
// 	console.log(obj.id)
// }, {
// 	scheduler: (fn) => {
// 		console.log(111)
// 		jobQueque.add(fn);
// 		flushJob();
// 	}
// });
// obj.id++;
// obj.id++;

// 验证watch onInvalidate每次注册，执行是要等下次cb执行的时候，才把上次注册的cleanup执行标志为无效
// watch(() => obj.text, (newVal, oldVal, onInvalidate) => {
// 	let expired = false;
// 	onInvalidate(() => {
// 		expired = true;
// 		console.log('come in expired')
// 	});
// 	console.log(expired)
// 	console.log(newVal, oldVal)
// }, {immediate: true, flush: 'post'})

// setTimeout(() =>{
// 	obj.text = 'hello qianqian!'
// 	console.log('obj.text chnage')
// }, 1000)
