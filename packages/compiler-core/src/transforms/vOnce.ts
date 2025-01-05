import type { NodeTransform } from '../transform'
import { findDir } from '../utils'
import { type ElementNode, type ForNode, type IfNode, NodeTypes } from '../ast'
import { SET_BLOCK_TRACKING } from '../runtimeHelpers'

const seen = new WeakSet()

// v-once指令处理
/**
 * v-once 是 Vue 中的一个指令，用于优化性能。它可以让绑定的内容只渲染 一次，之后不会参与后续的响应式更新。适用于不需要动态更新的静态内容。
 * demo1：渲染时，v-once 的内容会被缓存，后续直接复用缓存结果，避免重新渲染和计算。
 * <template>
    <div v-once>
      {{ message }}
    </div>
  </template>

  demo2:该 div 内的内容只会在初次渲染时生成，之后无论状态如何变化，它都不会更新。
  <template>
    <div v-once>
      <p>这是一个静态文本。</p>
    </div>
  </template>
 */
export const transformOnce: NodeTransform = (node, context) => {
  if (node.type === NodeTypes.ELEMENT && findDir(node, 'once', true)) {
    // 处理过的节点就返回，或者当前是不是已经处在inVOnce的状态了
    if (seen.has(node) || context.inVOnce || context.inSSR) {
      return
    }
    seen.add(node)
    context.inVOnce = true // 进入的时候标识当前状态是inVOnce
    context.helper(SET_BLOCK_TRACKING)
    return () => {
      context.inVOnce = false // 退出时，将inVOnce设置为false
      const cur = context.currentNode as ElementNode | IfNode | ForNode
      if (cur.codegenNode) {
        // 创建一个缓存表达式
        cur.codegenNode = context.cache(cur.codegenNode, true /* isVNode */)
      }
    }
  }
}
