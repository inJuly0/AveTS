import TokenType = require('../../lexer/tokentype');
import FunctionType, { ParameterTypeInfo } from '../../types/function-type';
import GenericType, {
  GenericTypeInstance,
  t_Array,
} from '../../types/generic-type';
import * as Typing from '../../types/types';
import Parser from '../parser';
import { TypeInfo } from '../ast/ast';

export default function parseType(parser: Parser): TypeInfo {
  if (parser.isValidType(parser.peek())) {
    let typeToken = parser.next();

    if (parser.match(TokenType.L_SQ_BRACE)) {
      parser.expect(TokenType.R_SQ_BRACE, "Expected ']' token.");
      return new TypeInfo(
        typeToken,
        t_Array.create(Typing.fromToken(typeToken))
      );
    } else if (parser.match(TokenType.LESS)) {
      // parse a generic type.
      let typeArgs: Typing.Type[] = [];
      while (!parser.match(TokenType.GREATER)) {
        let t = parser.next();

        if (!parser.isValidType(t)) {
          parser.error(`Unexpected token '${t.raw}'`, t);
          parser.consumeUntil(TokenType.GREATER);
          return new TypeInfo(t, Typing.t_error);
        }

        typeArgs.push(Typing.fromToken(t));

        if (!parser.match(TokenType.COMMA)) {
          parser.expect(TokenType.GREATER, "Expected ','");
          break;
        }
      }

      const genType = new GenericTypeInstance(typeToken.raw, typeArgs);
      return new TypeInfo(typeToken, genType);
    }

    return new TypeInfo(typeToken, Typing.fromToken(typeToken));
  }

  if (parser.match(TokenType.L_PAREN)) {
    return new TypeInfo(parser.prev(), parseFunctionType(parser));
  }

  return new TypeInfo(parser.peek(), Typing.t_any);
}

function parseFunctionType(parser: Parser): Typing.Type {
  let params = parseParams(parser);
  let returnType = Typing.t_any;

  if (parser.match(TokenType.ARROW)) {
    returnType = parseType(parser).type;
  }

  let ftype = new FunctionType('', params, returnType);
  return ftype;
}

function parseParams(parser: Parser): ParameterTypeInfo[] {
  let params: ParameterTypeInfo[] = [];
  while (!parser.match(TokenType.R_PAREN)) {
    params.push(parseParam(parser));
  }
  return params;
}

function parseParam(parser: Parser): ParameterTypeInfo {
  let name = parser.expect(TokenType.NAME, 'Expected paramter name.').raw;
  let type = Typing.t_any;

  if (parser.match(TokenType.COLON)) type = parseType(parser).type;

  return {
    name,
    type,
    required: true,
  };
}