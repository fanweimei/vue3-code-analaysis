// using literal strings instead of numbers so that it's easier to inspect
// debugger events

export enum TrackOpTypes {
  GET = 'get',
  HAS = 'has',
  ITERATE = 'iterate',
}

export enum TriggerOpTypes {
  SET = 'set',
  ADD = 'add',
  DELETE = 'delete',
  CLEAR = 'clear',
}

export enum ReactiveFlags {
  // 这个属性表示一个值是否应该被跳过，不进行响应式处理。通常在对对象进行深度遍历时，遇到某些特殊标记的值，需要跳过不处理，以避免循环引用或其他不必要的处理
  SKIP = '__v_skip',
  // 这个属性表示一个值是否已经被设置为响应式。在 Vue 3 的响应式系统中，会为对象的属性添加 getter 和 setter，从而实现数据的响应式变化。如果一个对象已经被设置为响应式，就会通过该标记进行标识。
  IS_REACTIVE = '__v_isReactive',
  // 这个属性表示一个值是否是只读的。在 Vue 3 的响应式系统中，可以通过 readonly 函数将对象转换为只读的，这样就无法对其进行修改操作。通过该标记可以进行判断，从而确定是否应该进行只读的处理。
  IS_READONLY = '__v_isReadonly',
  // 这个属性表示一个值是否是浅响应式的。在某些情况下，只需要对对象的顶层属性进行响应式处理，而不需要深度监听整个对象的变化。通过该标记可以进行标识，从而确定是否应该进行浅响应式处理。
  IS_SHALLOW = '__v_isShallow',
  // 这个属性表示一个值的原始版本。在 Vue 3 的响应式系统中，会为对象的属性添加 getter 和 setter，但有时需要获取对象的原始版本，而不是经过响应式处理后的版本。通过该标记可以进行标识，从而确定获取对象的原始版本。
  RAW = '__v_raw',
}

export enum DirtyLevels {
  NotDirty = 0,
  MaybeDirty = 1,
  Dirty = 2,
}
