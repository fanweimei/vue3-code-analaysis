import type { NodeTransform } from '../transform'
import { findDir } from '../utils'
import {
  ElementTypes,
  type MemoExpression,
  NodeTypes,
  type PlainElementNode,
  convertToBlock,
  createCallExpression,
  createFunctionExpression,
} from '../ast'
import { WITH_MEMO } from '../runtimeHelpers'

const seen = new WeakSet()

//指令v-memo
/**
 * 通过条件来缓存节点或组件的渲染结果。只有当指定的依赖条件发生变化时，才会重新渲染。
 * <template>
      <div v-memo="[dependency1, dependency2, ...]">
        <!-- 内容 -->
      </div>
    </template>
    v-memo 的值是一个 依赖数组，包含与渲染结果相关的状态或数据。
    只有当数组中的依赖项发生变化时，才会重新渲染该部分内容。

    <template>
      <ul>
        <li v-for="item in items" :key="item.id" v-memo="[item.name]">
          {{ item.name }} - {{ item.age }}
        </li>
      </ul>
      <button @click="updateAge">更新年龄</button>
    </template>
  只有name发生改变的时候才会重新渲染，age发生改变时不会渲染
 */
export const transformMemo: NodeTransform = (node, context) => {
  if (node.type === NodeTypes.ELEMENT) {
    const dir = findDir(node, 'memo')
    // 不存在或者已经处理过了就返回
    if (!dir || seen.has(node)) {
      return
    }
    seen.add(node)
    return () => {
      const codegenNode =
        node.codegenNode ||
        (context.currentNode as PlainElementNode).codegenNode
      if (codegenNode && codegenNode.type === NodeTypes.VNODE_CALL) {
        // non-component sub tree should be turned into a block
        if (node.tagType !== ElementTypes.COMPONENT) {
          convertToBlock(codegenNode, context)
        }
        node.codegenNode = createCallExpression(context.helper(WITH_MEMO), [
          dir.exp!,
          createFunctionExpression(undefined, codegenNode),
          `_cache`,
          String(context.cached++),
        ]) as MemoExpression
      }
    }
  }
}
