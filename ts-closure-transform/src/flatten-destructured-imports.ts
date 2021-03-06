import * as ts from 'typescript';

// This module implements a transformation that flattens destructured import
// statements.
//
// Essentially, what we're doing here is the following transformation:
//
//     import { a, b } from 'c';
//
// -->
//
//     import * as temp from 'c';
//     var a = temp.a;
//     var b = temp.b;
//
// The reason for why we do this is essentially just how the TypeScript
// compiler works: imports and exports are rewritten in a pretty underhanded
// way that breaks the closure transform.
//
// If we didn't do this transform, then we would get situations like the following:
//
//     Source:
//         import { a } from 'c';
//         let f = () => a;
//
//     Closure transform:
//         import { a } from 'c';
//         var temp;
//         let f = (temp = () => a, temp.__closure = () => ({ a: a }), temp);
//
//     Module import/export transform:
//         var _c = require('c');
//         var temp;
//         let f = (temp = () => _c.a, temp.__closure = () => ({ a: _c.a }), temp);
//
// The end result will fail horribly once deserialized because 'f' doesn't actually
// capture 'a' in the final code.
//
// We can't control the module import/export transform, but one thing we can do is
// insert a transform of our own prior to the closure transform. That's where this
// transform comes in.

/**
 * Applies a mapping to all unqualified identifiers in a node.
 * @param node The node to visit (recursively).
 * @param mapping The mapping to apply to all unqualified identifiers.
 * @param ctx A transformation context.
 */
function mapUnqualifiedIdentifiers<T extends ts.Node>(
  node: T,
  mapping: (identifier: ts.Identifier) => ts.Identifier,
  ctx: ts.TransformationContext): T {

  function visit<TNode extends ts.Node>(node: TNode): TNode {
    if (node === undefined) {
      return undefined;
    } else if (ts.isIdentifier(node)) {
      return <TNode><any>mapping(node);
    } else if (ts.isPropertyAccessExpression(node)) {
      return <TNode><any>ts.updatePropertyAccess(
        node,
        visit(node.expression),
        node.name);
    } else if (ts.isPropertyAssignment(node)) {
      return <TNode><any>ts.updatePropertyAssignment(
        node,
        node.name,
        visit(node.initializer));
    } else if (ts.isShorthandPropertyAssignment(node)) {
      return <TNode><any>ts.updateShorthandPropertyAssignment(
        node,
        node.name,
        visit(node.objectAssignmentInitializer));
    } else {
      return ts.visitEachChild(node, visit, ctx);
    }
  }

  return visit(node);
}

/**
 * Creates a visitor that rewrites imports.
 * @param ctx A transformation context.
 */
function createVisitor(ctx: ts.TransformationContext): ts.Visitor {
  function visitTopLevel<T extends ts.Node>(topLevel: T): T {

    // Maintain a set of all imports that have been flattened.
    let modifiedSet: string[] = [];

    function visit(node: ts.Node): ts.VisitResult<ts.Node> {
      if (ts.isImportDeclaration(node)) {
        let clause = node.importClause;
        if (clause) {
          let bindings = clause.namedBindings;
          if (ts.isNamedImports(bindings)) {
            // Named imports. That's exactly what we're looking for.

            // Create a temporary name for the imported module.
            let temp = ts.createTempVariable(undefined);

            // Bind each import to a variable.
            let importBindings = [];
            for (let specifier of bindings.elements) {
              importBindings.push(
                ts.createVariableStatement(
                  [],
                  [
                    ts.createVariableDeclaration(
                      specifier.name,
                      undefined,
                      ts.createPropertyAccess(temp, specifier.propertyName || specifier.name))
                  ]));
              modifiedSet.push(specifier.name.text);
            }

            return [
              ts.updateImportDeclaration(
                node,
                node.decorators,
                node.modifiers,
                ts.updateImportClause(
                  clause,
                  clause.name,
                  ts.createNamespaceImport(temp)),
                node.moduleSpecifier),
              ...importBindings
            ];
          }
        }
        return ts.visitEachChild(node, visit, ctx);
      } else {
        return ts.visitEachChild(node, visit, ctx);
      }
    }

    let visited = <T>visit(topLevel);
    return <T>mapUnqualifiedIdentifiers(
      visited,
      ident => {
        if (modifiedSet.indexOf(ident.text) >= 0) {
          // Replace the original identifier with a synthetic
          // identifier to keep the TypeScript compiler from
          // applying its import/export voodoo where it shouldn't.
          return ts.createIdentifier(ident.text);
        } else {
          return ident;
        }
      },
      ctx);
  }

  return visitTopLevel;
}

export default function () {
  return (ctx: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (sf: ts.SourceFile) => ts.visitNode(sf, createVisitor(ctx));
  }
}
