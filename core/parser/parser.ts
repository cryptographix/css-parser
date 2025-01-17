import dbg from "../../debug/debug.js";
const debug = dbg("parse");

import { lex } from "../lexer/lexer.ts";
import type { AST, Token, Rule, Decl } from "../../ast/mod.ts";

let _comments: boolean; // Whether comments are allowed.
let _depth: number; // Current block nesting depth.
let _position: boolean; // Whether to include line/column position.
let _tokens: Token[]; // Array of lexical tokens.

/**
 * Convert a CSS string or array of lexical tokens into a `stringify`-able AST.
 *
 * @param {String} css CSS string or array of lexical token
 * @param {Object} [options]
 * @param {Boolean} [options.comments=false] allow comment nodes in the AST
 * @param {Boolean} [options.position=false] include position in the AST
 * @returns {Object} `stringify`-able AST
 */
export function parse(css: string | Token[], options: {comments?: boolean, position?: boolean} = {}): AST {
  let start = 0; // Debug timer start.

  _comments = !!options.comments;
  _position = !!options.position;

  _depth = 0;

  // Operate on a copy of the given tokens, or the lex()'d CSS string.
  _tokens = Array.isArray(css) ? css.slice() : lex(css);

  const rules: Rule[] = [];
  let token: Token | undefined;

  start = Date.now();

  while ((token = next())) {
    const rule = parseToken(token);
    rule && rules.push(rule);
  }

  debug("ran in", Date.now() - start + "ms");

  return {
    type: "stylesheet",
    stylesheet: {
      rules: rules,
    },
  };
}

// -- Functions --------------------------------------------------------------

/**
 * Build an AST node from a lexical token.
 *
 * @param {Object} token lexical token
 * @param {Object} [override] object hash of properties that override those
 *   already in the token, or that will be added to the token.
 * @returns {Object} AST node
 */
function astNode(token: Token, overrd?: Record<string,unknown>): Rule {
  const override: Record<string,unknown> = overrd ?? {};

  const node: any= {};

  if (token.type) {
    node.type = override.type ?? token.type;
  }
  if (token.name) {
    node.name = override.name ?? token.name;
  }
  if (token.value) {
    node.value = override.value ?? token.value;
  }

  const keys = Object.keys(override);
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i];
    const n = node as Record<string, unknown>;

    if (!n[key]) {
      n[key] = override[key];
    }
  }

  if (_position) {
    node.position = {
      start: token.start,
      end: token.end,
    };
  }

  debug("astNode:", JSON.stringify(node, null, 2));

  return node;
}

/**
 * Remove a lexical token from the stack and return the removed token.
 *
 * @returns {Object} lexical token
 */
function next(): Token | undefined {
  const token = _tokens.shift();
  debug("next:", JSON.stringify(token, null, 2));
  return token;
}

// -- Parse* Functions ---------------------------------------------------------

/**
 * Convert an @-group lexical token to an AST node.
 *
 * @param {Object} token @-group lexical token
 * @returns {Object} @-group AST node
 */
function parseAtGroup(token: Token): any {
  _depth = _depth + 1;

  // As the @-group token is assembled, relevant token values are captured here
  // temporarily. They will later be used as `tokenize()` overrides.
  let overrides: any = {};

  switch (token.type) {
    case "font-face":
    case "viewport":
      overrides.declarations = parseDeclarations();
      break;

    case "page":
      overrides.prefix = token.prefix;
      overrides.declarations = parseDeclarations();
      break;

    default:
      overrides.prefix = token.prefix;
      overrides.rules = parseRules();
  }

  return astNode(token, overrides);
}

/**
 * Convert an @import lexical token to an AST node.
 *
 * @param {Object} token @import lexical token
 * @returns {Object} @import AST node
 */
function parseAtImport(token: Token): any {
  return astNode(token);
}

/**
 * Convert an @charset token to an AST node.
 *
 * @param {Object} token @charset lexical token
 * @returns {Object} @charset node
 */
function parseCharset(token: Token): any {
  return astNode(token);
}

/**
 * Convert a comment token to an AST Node.
 *
 * @param {Object} token comment lexical token
 * @returns {Object} comment node
 */
function parseComment(token: Token): any {
  return astNode(token, { text: token.text });
}

function parseNamespace(token: Token): any {
  return astNode(token);
}

/**
 * Convert a property lexical token to a property AST node.
 *
 * @returns {Object} property node
 */
function parseProperty(token: Token): any {
  return astNode(token);
}

/**
 * Convert a selector lexical token to a selector AST node.
 *
 * @param {Object} token selector lexical token
 * @returns {Object} selector node
 */
function parseSelector(token: Token): Rule {
  function trim(str: string) {
    return str.trim();
  }

  return astNode(token, {
    type: "rule",
    selectors: token.text!.split(",").map(trim),
    // parseDeclarations(token)
    declarations: parseDeclarations(),
  });
}

/**
 * Convert a lexical token to an AST node.
 *
 * @returns {Object|undefined} AST node
 */
function parseToken(token: Token): Rule | null {
  switch (token.type) {
    // Cases are listed in roughly descending order of probability.
    case "property":
      return parseProperty(token);

    case "selector":
      return parseSelector(token);

    case "at-group-end":
      _depth = _depth - 1;
      return null;

    case "media":
    case "keyframes":
      return parseAtGroup(token);

    case "comment":
      if (_comments) return parseComment(token);
      break;

    case "charset":
      return parseCharset(token);
    case "import":
      return parseAtImport(token);

    case "namespace":
      return parseNamespace(token);

    case "font-face":
    case "supports":
    case "viewport":
    case "document":
    case "page":
      return parseAtGroup(token);
  }

  debug("parseToken: unexpected token:", JSON.stringify(token));

  return null;
}

// -- Parse Helper Functions ---------------------------------------------------

/**
 * Iteratively parses lexical tokens from the stack into AST nodes until a
 * conditional function returns `false`, at which point iteration terminates
 * and any AST nodes collected are returned.
 *
 * @param {Function} conditionFn
 *   @param {Object} token the lexical token being parsed
 *   @returns {Boolean} `true` if the token should be parsed, `false` otherwise
 * @return {Array} AST nodes
 */
function parseTokensWhile(conditionFn: (token: Token) => boolean | number): Rule[] {
  const nodes: Rule[] = [];
  let token: Token | undefined;

  while ((token = next()) && conditionFn && conditionFn(token)) {
    const node = parseToken(token);

    node && nodes.push(node);
  }

  // Place an unused non-`end` lexical token back onto the stack.
  if (token && token.type !== "end") {
    _tokens.unshift(token);
  }

  return nodes;
}

/**
 * Convert a series of tokens into a sequence of declaration AST nodes.
 *
 * @returns {Array} declaration nodes
 */
function parseDeclarations(): Decl[] {
  return parseTokensWhile(function (token) {
    return token.type === "property" || token.type === "comment";
  }) as Decl[];
}

/**
 * Convert a series of tokens into a sequence of rule nodes.
 *
 * @returns {Array} rule nodes
 */
function parseRules(): Rule[] {
  return parseTokensWhile(function () {
    return _depth;
  });
}
