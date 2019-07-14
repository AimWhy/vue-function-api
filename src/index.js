var noopFn = _ => _;

var toString = x => Object.prototype.toString.call(x);

var isArray = x => toString(x) === `[object Array]`;

var isPlainObject = x => toString(x) === `[object Object]`;

var hasOwn = (obj, key) =>
  obj && Object.prototype.hasOwnProperty.call(obj, key);

function assert(condition, msg) {
  if (!condition) {
    throw new Error(`[vue-function-api] ${msg}`);
  }
}

function proxy(target, source, targetKey, sourceKey = targetKey) {
  Object.defineProperty(target, targetKey, {
    enumerable: true,
    configurable: false,
    get: function proxyGetter() {
      return source[sourceKey];
    },
    set: function proxySetter(val) {
      source[sourceKey] = val;
    }
  });
}

var currentVue = null;
function getCurrentVue() {
  assert(currentVue, `must call Vue.use(plugin) before using any function.`);
  return currentVue;
}
function setCurrentVue(vue) {
  currentVue = vue;
}
function vueWarn(msg, vm) {
  getCurrentVue().util.warn(msg, vm);
}

var currentVM = null;
function getCurrentVM() {
  return currentVM;
}
function setCurrentVM(vm) {
  currentVM = vm;
}
function ensureCurrentVMInFn(hook) {
  var vm = getCurrentVM();
  assert(vm, `"${hook}" get called outside of "setup()"`);
  return vm;
}

// createComponent

export function createComponent(compOptions) {
  return typeof compOptions === `function`
    ? { setup: compOptions }
    : compOptions;
}

// For state / value / state

function ValueWrapper(v) {
  this.observe = v;
}

Object.defineProperty(ValueWrapper.prototype, `value`, {
  get() {
    return this.observe.$$value;
  },
  set(v) {
    this.observe.$$value = v;
  },
  enumerable: true,
  configurable: true
});

function isValueWrapper(obj) {
  return obj instanceof ValueWrapper;
}

function unProxy(obj) {
  if (obj) {
    var keys = Object.keys(obj);
    for (var index = 0; index < keys.length; index++) {
      var key = keys[index];
      var value_1 = obj[key];
      if (isValueWrapper(value_1)) {
        proxy(obj, value_1.observe, key, `$$value`);
      } else if (
        !hasOwn(value_1, `__ob__`) &&
        (isPlainObject(value_1) || isArray(value_1))
      ) {
        obj[key] = unProxy(value_1);
      }
    }
  }
  return obj;
}

function observable(obj) {
  var Vue = getCurrentVue();
  if (Vue.observable) {
    return Vue.observable(obj);
  }

  var silent = Vue.config.silent;
  Vue.config.silent = true;
  var vm = new Vue({ data: { $$state: obj } });
  Vue.config.silent = silent;
  return vm._data.$$state;
}

// state

export function state(value) {
  return observable(
    isArray(value) || isPlainObject(value) ? unProxy(value) : value
  );
}

// value

export function value(value) {
  return new ValueWrapper(
    observable({
      $$value: isArray(value) || isPlainObject(value) ? unProxy(value) : value
    })
  );
}

// computed

function compoundComputed(computed) {
  var Vue = getCurrentVue();
  var silent = Vue.config.silent;
  Vue.config.silent = true;
  var reactive = new Vue({ computed: computed });
  Vue.config.silent = silent;
  return reactive;
}

export function computed(getter, setter) {
  var computedHost = compoundComputed({
    $$value: { get: getter, set: setter }
  });
  return new ValueWrapper(computedHost);
}

// lifeCycle

var genName = function(name) {
  return `on${name[0].toUpperCase()}${name.slice(1)}`;
};

function createLifeCycle(lifeCycleHook) {
  return function(callback) {
    var vm = ensureCurrentVMInFn(genName(lifeCycleHook));
    vm.$on(`hook:${lifeCycleHook}`, callback);
  };
}

function createLifeCycles(lifeCycleHooks, name) {
  return function(callback) {
    var vm = ensureCurrentVMInFn(genName(name));
    lifeCycleHooks.forEach(function(lifeCycleHook) {
      return vm.$on(`hook:${lifeCycleHook}`, callback);
    });
  };
}

export const onCreated = createLifeCycle(`created`);
export const onBeforeMount = createLifeCycle(`beforeMount`);
export const onMounted = createLifeCycle(`mounted`);
export const onBeforeUpdate = createLifeCycle(`beforeUpdate`);
export const onUpdated = createLifeCycle(`updated`);
export const onActivated = createLifeCycle(`activated`);
export const onDeactivated = createLifeCycle(`deactivated`);
export const onBeforeDestroy = createLifeCycle(`beforeDestroy`);
export const onDestroyed = createLifeCycle(`destroyed`);
export const onErrorCaptured = createLifeCycle(`errorCaptured`);
export const onUnmounted = createLifeCycles(
  [`destroyed`, `deactivated`],
  `unmounted`
);

// watch

var WatcherPreFlushQueueKey = `vfa.key.preFlushQueue`;
var WatcherPostFlushQueueKey = `vfa.key.postFlushQueue`;
var fallbackVM;

function hasWatchEnv(vm) {
  return vm[WatcherPreFlushQueueKey] !== undefined;
}

function installWatchEnv(vm) {
  vm[WatcherPreFlushQueueKey] = [];
  vm[WatcherPostFlushQueueKey] = [];
  vm.$on(`hook:beforeUpdate`, createFlusher(WatcherPreFlushQueueKey));
  vm.$on(`hook:updated`, createFlusher(WatcherPostFlushQueueKey));
}

function createFlusher(key) {
  return function() {
    flushQueue(this, key);
  };
}

function flushQueue(vm, key) {
  var queue = vm[key];
  for (var index = 0; index < queue.length; index++) {
    queue[index]();
  }
  queue.length = 0;
}

function flushWatcherCallback(vm, fn, mode) {
  function fallbackFlush() {
    vm.$nextTick(function() {
      if (vm[WatcherPreFlushQueueKey].length) {
        flushQueue(vm, WatcherPreFlushQueueKey);
      }
      if (vm[WatcherPostFlushQueueKey].length) {
        flushQueue(vm, WatcherPostFlushQueueKey);
      }
    });
  }
  switch (mode) {
    case `pre`:
      fallbackFlush();
      return vm[WatcherPreFlushQueueKey].push(fn);
    case `post`:
      fallbackFlush();
      return vm[WatcherPostFlushQueueKey].push(fn);
    case `sync`:
      return fn();
    default:
      return assert(
        false,
        `flush must be one of ["post", "pre", "sync"], but got ${mode}`
      );
  }
}

function createSingleSourceWatcher(vm, source, cb, options) {
  var getter = isValueWrapper(source) ? _ => source.observe.$$value : source;
  let cleanUp = noopFn;
  let cbWrap = function(n, o) {
    cleanUp();
    cb(n, o, function(v) {
      cleanUp = v;
    });
  };

  var callbackRef = function(n, o) {
    callbackRef = flush;
    return !options.lazy ? cbWrap(n, o) : flush(n, o);
  };

  var flush = function(n, o) {
    flushWatcherCallback(vm, _ => cbWrap(n, o), options.flush);
  };

  var unwatch = vm.$watch(getter, callbackRef, {
    immediate: !options.lazy,
    deep: options.deep,
    sync: options.flush === `sync`
  });

  return function stop() {
    cleanUp();
    unwatch();
  };
}

function createMultiSourceWatcher(vm, sources, cb, options) {
  var pre = Array(sources.length);
  var cur = Array(sources.length);

  let cleanUp = noopFn;
  let cbWrap = function(n, o) {
    cleanUp();
    cb(n, o, function(v) {
      cleanUp = v;
    });
  };

  var unwatchArr = sources.map(function(source, i) {
    return (function(_source, _i) {
      return createSingleSourceWatcher(
        vm,
        _source,
        function(n, v) {
          pre[_i] = v;
          cur[_i] = n;
          cbWrap(cur, pre);
        },
        options
      );
    })(source, i);
  });

  return function stop() {
    cleanUp();
    unwatchArr.forEach(v => v());
  };
}

export function watch(source, cb, options = {}) {
  var opts = Object.assign(
    { lazy: false, deep: false, flush: `post` },
    options
  );
  var vm = getCurrentVM();
  if (!vm) {
    if (!fallbackVM) {
      var Vue_1 = getCurrentVue();
      var silent = Vue_1.config.silent;
      Vue_1.config.silent = true;
      fallbackVM = new Vue_1();
      Vue_1.config.silent = silent;
    }
    vm = fallbackVM;
    opts.flush = `sync`;
  }

  if (!hasWatchEnv(vm)) {
    installWatchEnv(vm);
  }

  return (isArray(source)
    ? createMultiSourceWatcher
    : createSingleSourceWatcher)(vm, source, cb, opts);
}

// provide

export function provide(provideOption) {
  if (provideOption) {
    var vm = ensureCurrentVMInFn(`provide`);
    vm._provided =
      typeof provideOption === `function`
        ? provideOption.call(vm)
        : provideOption;
  }
}

// inject

export function inject(injectKey) {
  if (injectKey) {
    var vm = ensureCurrentVMInFn(`inject`);
    var source = vm;
    while (source) {
      if (source._provided && hasOwn(source._provided, injectKey)) {
        return source._provided[injectKey];
      }
      source = source.$parent;
    }
    vueWarn(`Injection "${injectKey}" not found`, vm);
  }
}

// plugin

function _install(Vue, mixin) {
  if (currentVue && currentVue === Vue) {
    assert(
      false,
      `already installed. Vue.use(plugin) should be called only once`
    );
    return;
  }

  Vue.config.optionMergeStrategies.setup =
    Vue.config.optionMergeStrategies.data;
  setCurrentVue(Vue);
  mixin(Vue);
}

function checkData(vm, propName) {
  var props = vm.$options.props;
  var methods = vm.$options.methods;
  var computed = vm.$options.computed;
  var msgPrefix = `The setup binding property "${propName}" is already declared`;
  var msgSuffix = `.`;

  if (hasOwn(vm.$data, propName)) {
    msgSuffix = `as a data.`;
  } else if (props && hasOwn(props, propName)) {
    msgSuffix = `as a prop.`;
  } else if (methods && hasOwn(methods, propName)) {
    msgSuffix = `as a method.`;
  } else if (computed && hasOwn(computed, propName)) {
    msgSuffix = `as a computed.`;
  }
  if (msgSuffix !== `.`) {
    vueWarn(msgPrefix + msgSuffix, vm);
  }
}

function mixin(Vue) {
  Vue.mixin({ created: setupMix });

  function setupMix() {
    var vm = this;
    var setup = vm.$options.setup;

    if (!setup) {
      return;
    }

    if (typeof setup !== `function`) {
      return vueWarn(
        `The "setup" option should be a function that returns a object in component definitions.`,
        vm
      );
    }

    var binding;
    var ctx = createContext(vm);

    setCurrentVM(vm);
    try {
      binding = setup(vm.$props || {}, ctx);
    } catch (err) {
      vueWarn(`there is an error occuring in "setup"`, vm);
      console.log(err);
    } finally {
      setCurrentVM(null);
    }

    if (!binding) {
      return;
    }

    if (!isPlainObject(binding)) {
      if (typeof binding === `function`) {
        vm.$options.render = function(h) {
          return binding(ctx.props, ctx.slots, ctx.attrs);
        };
      } else {
        assert(
          false,
          `"setup" must return a "Object" or "Function", get "${toString(
            binding
          )}"`
        );
      }
      return;
    }

    Object.keys(binding).forEach(name => checkData(vm, name));

    vm._data2 = observable(unProxy(binding));

    Object.keys(binding).forEach(key => proxy(vm, vm._data2, key));
  }

  function createContext(vm) {
    var ctx = { vm };
    var props = [`props`, `parent`, `root`, `refs`, `slots`, `attrs`];
    var methodWithoutReturn = [`emit`];

    props.forEach(function(key) {
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: function() {
          return vm[`$${key}`];
        },
        set: function() {
          vueWarn(
            `Cannot assign to "${key}" because it is a read-only property`,
            vm
          );
        }
      });
    });

    methodWithoutReturn.forEach(function(key) {
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: function() {
          return function() {
            var args = [];
            for (var _i = 0; _i < arguments.length; _i++) {
              args[_i] = arguments[_i];
            }
            vm[`$${key}`].apply(vm, args);
          };
        },
        set: noopFn
      });
    });

    return ctx;
  }
}

export const plugin = {
  install: function install(Vue) {
    return _install(Vue, mixin);
  }
};
