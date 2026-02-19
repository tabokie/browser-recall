// Query builder tree — pure node constructors and tree algorithms

let qbNodeIdCounter = 0;

export function qbCreatePredicate(predicateType, config = {}) {
  return { id: ++qbNodeIdCounter, type: 'predicate', predicateType, ...config };
}

export function qbCreateOperator(op, children) {
  return { id: ++qbNodeIdCounter, type: 'operator', op, children };
}

export function qbCreatePlaceholder(defaultFields) {
  return { id: ++qbNodeIdCounter, type: 'predicate', predicateType: 'keyword', field: [...defaultFields], value: '' };
}

export function qbFindNode(root, id) {
  if (!root) return null;
  if (root.id === id) return { node: root, parent: null, childIndex: -1 };
  if (root.type === 'operator') {
    for (let i = 0; i < root.children.length; i++) {
      if (root.children[i].id === id) return { node: root.children[i], parent: root, childIndex: i };
    }
    for (let i = 0; i < root.children.length; i++) {
      const found = qbFindNode(root.children[i], id);
      if (found) return found;
    }
  }
  return null;
}

// Recursively collapse operators: single-child → unwrap, empty → remove (null)
export function qbCollapseTree(node) {
  if (!node || node.type !== 'operator') return node;
  node.children = node.children.map(c => qbCollapseTree(c)).filter(c => c !== null);
  if (node.children.length === 1) return node.children[0];
  if (node.children.length === 0) return null; // signal removal to parent
  return node;
}

// Flatten same-op nesting (e.g. OR(OR(A,B),C) → OR(A,B,C))
export function qbFlattenSameOp(node) {
  if (!node || node.type !== 'operator') return node;
  node.children = node.children.map(c => qbFlattenSameOp(c));
  const newChildren = [];
  for (const child of node.children) {
    if (child.type === 'operator' && child.op === node.op) {
      newChildren.push(...child.children);
    } else {
      newChildren.push(child);
    }
  }
  node.children = newChildren;
  return node;
}

// Mode switching: predicates → flat OR tree, or tree → predicate list
export function qbToTree(predicates) {
  if (predicates.length === 0) return qbCreatePlaceholder([]);
  if (predicates.length === 1) return predicates[0];
  return qbCreateOperator('OR', predicates);
}

export function qbFlatten(node) {
  if (!node) return [];
  if (node.type === 'predicate') return [node];
  return node.children.flatMap(c => qbFlatten(c));
}
