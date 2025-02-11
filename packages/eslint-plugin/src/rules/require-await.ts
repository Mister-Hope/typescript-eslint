import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import * as tsutils from 'ts-api-utils';
import type * as ts from 'typescript';

import {
  createRule,
  getFunctionNameWithKind,
  getParserServices,
  isArrowToken,
  isOpeningParenToken,
  nullThrows,
  NullThrowsReasons,
  upperCaseFirst,
} from '../util';

interface ScopeInfo {
  upper: ScopeInfo | null;
  hasAwait: boolean;
  hasAsync: boolean;
  isGen: boolean;
  isAsyncYield: boolean;
}
type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

export default createRule({
  name: 'require-await',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow async functions which have no `await` expression',
      recommended: 'recommended',
      requiresTypeChecking: true,
      extendsBaseRule: true,
    },
    schema: [],
    messages: {
      missingAwait: "{{name}} has no 'await' expression.",
    },
  },
  defaultOptions: [],
  create(context) {
    const services = getParserServices(context);
    const checker = services.program.getTypeChecker();

    const sourceCode = context.getSourceCode();
    let scopeInfo: ScopeInfo | null = null;

    /**
     * Push the scope info object to the stack.
     */
    function enterFunction(node: FunctionNode): void {
      scopeInfo = {
        upper: scopeInfo,
        hasAwait: false,
        hasAsync: node.async,
        isGen: node.generator || false,
        isAsyncYield: false,
      };
    }

    /**
     * Pop the top scope info object from the stack.
     * Also, it reports the function if needed.
     */
    function exitFunction(node: FunctionNode): void {
      /* istanbul ignore if */ if (!scopeInfo) {
        // this shouldn't ever happen, as we have to exit a function after we enter it
        return;
      }

      if (
        node.async &&
        !scopeInfo.hasAwait &&
        !isEmptyFunction(node) &&
        !(scopeInfo.isGen && scopeInfo.isAsyncYield)
      ) {
        context.report({
          node,
          loc: getFunctionHeadLoc(node, sourceCode),
          messageId: 'missingAwait',
          data: {
            name: upperCaseFirst(getFunctionNameWithKind(node)),
          },
        });
      }

      scopeInfo = scopeInfo.upper;
    }

    /**
     * Checks if the node returns a thenable type
     */
    function isThenableType(node: ts.Node): boolean {
      const type = checker.getTypeAtLocation(node);

      return tsutils.isThenableType(checker, node, type);
    }

    /**
     * Marks the current scope as having an await
     */
    function markAsHasAwait(): void {
      if (!scopeInfo) {
        return;
      }
      scopeInfo.hasAwait = true;
    }

    /**
     * mark `scopeInfo.isAsyncYield` to `true` if its a generator
     * function and the delegate is `true`
     */
    function markAsHasDelegateGen(node: TSESTree.YieldExpression): void {
      if (!scopeInfo?.isGen || !node.argument) {
        return;
      }

      if (node.argument.type === AST_NODE_TYPES.Literal) {
        // making this `false` as for literals we don't need to check the definition
        // eg : async function* run() { yield* 1 }
        scopeInfo.isAsyncYield ||= false;
      }

      const type = services.getTypeAtLocation(node.argument);
      const typesToCheck = expandUnionOrIntersectionType(type);
      for (const type of typesToCheck) {
        const asyncIterator = tsutils.getWellKnownSymbolPropertyOfType(
          type,
          'asyncIterator',
          checker,
        );
        if (asyncIterator !== undefined) {
          scopeInfo.isAsyncYield = true;
          break;
        }
      }
    }

    return {
      FunctionDeclaration: enterFunction,
      FunctionExpression: enterFunction,
      ArrowFunctionExpression: enterFunction,
      'FunctionDeclaration:exit': exitFunction,
      'FunctionExpression:exit': exitFunction,
      'ArrowFunctionExpression:exit': exitFunction,

      AwaitExpression: markAsHasAwait,
      'VariableDeclaration[kind = "await using"]': markAsHasAwait,
      'ForOfStatement[await = true]': markAsHasAwait,
      'YieldExpression[delegate = true]': markAsHasDelegateGen,

      // check body-less async arrow function.
      // ignore `async () => await foo` because it's obviously correct
      'ArrowFunctionExpression[async = true] > :not(BlockStatement, AwaitExpression)'(
        node: Exclude<
          TSESTree.Node,
          TSESTree.AwaitExpression | TSESTree.BlockStatement
        >,
      ): void {
        const expression = services.esTreeNodeToTSNodeMap.get(node);
        if (expression && isThenableType(expression)) {
          markAsHasAwait();
        }
      },
      ReturnStatement(node): void {
        // short circuit early to avoid unnecessary type checks
        if (!scopeInfo || scopeInfo.hasAwait || !scopeInfo.hasAsync) {
          return;
        }

        const { expression } = services.esTreeNodeToTSNodeMap.get(node);
        if (expression && isThenableType(expression)) {
          markAsHasAwait();
        }
      },
    };
  },
});

function isEmptyFunction(node: FunctionNode): boolean {
  return (
    node.body?.type === AST_NODE_TYPES.BlockStatement &&
    node.body.body.length === 0
  );
}

// https://github.com/eslint/eslint/blob/03a69dbe86d5b5768a310105416ae726822e3c1c/lib/rules/utils/ast-utils.js#L382-L392
/**
 * Gets the `(` token of the given function node.
 */
function getOpeningParenOfParams(
  node: FunctionNode,
  sourceCode: TSESLint.SourceCode,
): TSESTree.Token {
  return nullThrows(
    node.id
      ? sourceCode.getTokenAfter(node.id, isOpeningParenToken)
      : sourceCode.getFirstToken(node, isOpeningParenToken),
    NullThrowsReasons.MissingToken('(', node.type),
  );
}

// https://github.com/eslint/eslint/blob/03a69dbe86d5b5768a310105416ae726822e3c1c/lib/rules/utils/ast-utils.js#L1220-L1242
/**
 * Gets the location of the given function node for reporting.
 */
function getFunctionHeadLoc(
  node: FunctionNode,
  sourceCode: TSESLint.SourceCode,
): TSESTree.SourceLocation {
  const parent = nullThrows(node.parent, NullThrowsReasons.MissingParent);
  let start = null;
  let end = null;

  if (node.type === AST_NODE_TYPES.ArrowFunctionExpression) {
    const arrowToken = nullThrows(
      sourceCode.getTokenBefore(node.body, isArrowToken),
      NullThrowsReasons.MissingToken('=>', node.type),
    );

    start = arrowToken.loc.start;
    end = arrowToken.loc.end;
  } else if (
    parent.type === AST_NODE_TYPES.Property ||
    parent.type === AST_NODE_TYPES.MethodDefinition
  ) {
    start = parent.loc.start;
    end = getOpeningParenOfParams(node, sourceCode).loc.start;
  } else {
    start = node.loc.start;
    end = getOpeningParenOfParams(node, sourceCode).loc.start;
  }

  return {
    start,
    end,
  };
}

function expandUnionOrIntersectionType(type: ts.Type): ts.Type[] {
  if (type.isUnionOrIntersection()) {
    return type.types.flatMap(expandUnionOrIntersectionType);
  }
  return [type];
}
