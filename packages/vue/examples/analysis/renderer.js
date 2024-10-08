const dynamicChildStack = [];
let currentDynamicChildren = [];

function openBlock() {
	dynamicChildStack.push(currentDynamicChildren = []);
}

function closeBlock() {
	currentDynamicChildren = dynamicChildStack.pop();
}

function createVNode(tag, props, children, flags) {
	const key = props && props.key;
	props && delete props.key;
	
	const vnode = {
		tag,
		props,
		children,
		key,
		patchFlags: flags
	}
	
	if(typeof flags !== undefined && currentDynamicChildren) {
		currentDynamicChildren.push(vnode);
	}
	
	return node;
}

function createBlock(tag, props, children) {
	openBlock();
	const block = createVNode(tag, props, children);
	block.dynamicChildren = currentDynamicChildren;
	closeBlock();
	return block;
}

function render() {
	return createBlock('div', null, [
		createVNode('p', {class: 'foo'}, null, 1),
		createVNode('p', {class: 'bar'}, null)
	])
}