//step 1 ---DSL模板 --- to ---- 模板AST
const State = {
	initial: 1,
	tagOpen: 2,
	tagName: 3,
	text: 4,
	tagEnd: 5,
	tagEndName: 6
}

function isAlpha(char) {
	return char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z'
}

function tokenize(str) {
	let currentState = State.initial;
	const chars = [];
	const tokens = [];
	let i = 0;
	while (i < str.length) {
		const char = str[i];
		switch (currentState) {
			case State.initial:
				if (char === '<') {
					currentState = State.tagOpen;
					i++;
				} else if (isAlpha(char)) {
					currentState = State.text;
					chars.push(char);
					i++;
				}
				break;
			case State.tagOpen:
				if (isAlpha(char)) {
					currentState = State.tagName;
					chars.push(char);
					i++;
				} else if (char === '/') {
					currentState = State.tagEnd;
					i++;
				}
				break;
			case State.tagName:
				if (isAlpha(char)) {
					chars.push(char);
					i++;
				} else if (char === '>') {
					currentState = State.initial;
					tokens.push({
						type: 'tag',
						name: chars.join('')
					});
					chars.length = 0;
					i++;
				}
				break;
			case State.text:
				if (isAlpha(char)) {
					chars.push(char);
					i++;
				} else if (char === '<') {
					currentState = State.tagOpen;
					tokens.push({
						type: 'text',
						content: chars.join('')
					});
					chars.length = 0;
					i++;
				}
				break;
			case State.tagEnd:
				if (isAlpha(char)) {
					currentState = State.tagEndName;
					chars.push(char);
					i++;
				}
				break;
			case State.tagEndName:
				if (isAlpha(char)) {
					chars.push(char);
					i++;
				} else if (char === '>') {
					currentState = State.initial;
					tokens.push({
						type: 'tagEnd',
						name: chars.join('')
					});
					chars.length = 0;
					i++;
				}
				break;
		}
	}
	return tokens;
}

function parse(str) {
	const tokens = tokenize(str);
	const root = {
		type: "Root",
		children: []
	};
	const elementStack = [root];
	while(tokens.length) {
		const t = tokens.shift();
		const parent = elementStack[elementStack.length-1];
		switch(t.type) {
			case 'tag':
				const elementNode = {
					type: 'Element',
					tag: t.name,
					children: []
				};
				parent.children.push(elementNode);
				elementStack.push(elementNode);
				break;
			case 'text':
				const textNode = {
					type: "Text",
					content: t.content
				};
				parent.children.push(textNode);
				break;
			case 'tagEnd':
				elementStack.pop();
				break;
		}
	}
	return root;
}

function dump(node, indent=0) {
	const type = node.type;
	const desc = node.type === 'Root' ? '' : (node.type === 'Element' ? node.tag : node.content);
	console.log(`${'-'.repeat(indent)}${type}:${desc}`);
	
	if(node.children) {
		node.children.forEach(n => dump(n, indent+2))
	}
}

function traverseNode(ast, context) {
	context.currentNode = ast;
	const transforms = context.nodeTransforms;
	const exitFns = [];
	for(let trf of transforms) {
		const onExit = trf(context.currentNode, context);
		if(onExit) {
			exitFns.push(onExit);
		}
		if(!context.currentNode) {
			return;
		}
	}
	
	const children = context.currentNode.children;
	if(children) {
		let i=0;
		for(let child of children) {
			context.parent = context.currentNode;
			context.childIndex = i;
			traverseNode(child, context);
			i++;
		}
	}
	
	let i = exitFns.length;
	while(i--) {
		exitFns[i]();
	}
}

function transform(ast) {
	const context = {
		currentNode: null,
		childIndex: 0,
		parent: null,
		replaceNode(node) {
			context.parent.children[context.childIndex] = node;
			context.currentNode = node;
		},
		removeNode() {
			if(context.parent) {
				context.parent.children.splice(context.childIndex, 1);
				context.currentNode = null;
				context.childIndex = -1;
			}
		},
		nodeTransforms: [
			transformElement,
			transformText,
			transformRoot
		]
	};
	traverseNode(ast, context);
	return ast;
}

function transformElement(node, context) {
	return () => {
		if(node.type !== 'Element') {
			return;
		}
		const callExp = createCallExpression('h', [
			createStringLiteral(node.tag)
		]);
		if(node.children.length === 1) {
			callExp.arguments.push(node.children[0].jsNode);
		} else {
			callExp.arguments.push(createArrayExpression(node.children.map(c => c.jsNode)));
		}
		node.jsNode = callExp;
	}
}

function transformText(node, context){
	if(node.type !== 'Text') {
		return;
	}
	node.jsNode = createStringLiteral(node.content);
}

function transformRoot(node) {
	return () => {
		if(node.type !== 'Root') {
			return;
		}
		const vnodeJsAst = node.children[0].jsNode;
		node.jsNode = {
			type: 'FunctionDecl',
			id: createIdentifier('render'),
			params: [],
			body: [
				{
					type: 'ReturnStatement',
					return: vnodeJsAst
				}
			]
		}
	}
}

// step 2: 模板AST --- to ---- Javascript Ast
function createStringLiteral(value) {
	return {
		type: 'StringLiteral',
		value
	}
}

function createStringLiteral(value) {
	return {
		type: 'StringLiteral',
		value
	}
}

function createIdentifier(name) {
	return {
		type: 'Identifier',
		name
	}
}

function createArrayExpression(elements) {
	return {
		type: 'ArrayExpression',
		elements
	}
}

function createCallExpression(callee, arguments) {
	return {
		type: 'CallExpression',
		callee: createIdentifier(callee),
		arguments
	}
}


// step3 Javascript AST --- to --- Javascript code
function generate(node) {
	const context = {
		code: '',
		push(code) {
			context.code += code;
		},
		currentIndent: 0,
		newline() {
			context.code += '\n' + `  `.repeat(context.currentIndent);
		},
		indent() {
			context.currentIndent++;
			context.newline();
		},
		deIndent() {
			context.currentIndent--;
			context.newline();
		}
	};
	genNode(node, context);
	return context.code;
}

function genNode(node, context) {
	switch(node.type) {
		case 'FunctionDecl':
			genFunctionDecl(node, context);
			break;
		case 'ReturnStatement':
			genReturnStatement(node, context);
			break;
		case 'CallExpression':
			genCallExpression(node, context);
			break;
		case 'StringLiteral':
			genStringLiteral(node, context);
			break;
		case 'ArrayExpression':
			genArrayExpression(node, context);
			break;
	}
}

function genFunctionDecl(node, context) {
	const { push, indent, deIndent } = context;
	push(`function ${node.id.name}`);
	push('(');
	genNodeList(node.params, context);
	push(') ');
	push('{')
	indent();
	node.body.forEach(n => genNode(n, context));
	deIndent();
	push('}');
}

function genNodeList(nodes, context) {
	const { push } = context;
	for(let i=0; i<nodes.length; i++) {
		const node = nodes[i];
		genNode(node, context);
		if(i<nodes.length-1) {
			push(', ');
		}
	}
}

function genArrayExpression(node, context) {
	const { push } = context;
	push('[');
	genNodeList(node.elements, context);
	push(']');
}

function genReturnStatement(node, context) {
	const { push } = context;
	push(`return `);
	genNode(node.return, context);
}

function genStringLiteral(node, context) {
	const { push } = context;
	push(`'${node.value}'`);
}

function genCallExpression(node, context) {
	const { push } = context;
	const { callee, arguments: args } = node;
	push(`${callee.name}(`);
	genNodeList(args, context);
	push(')');
}

function compile(template) {
	const ast = parse(template);
	transform(ast);
	console.log(ast)
	const code = generate(ast.jsNode);
	return code;
}