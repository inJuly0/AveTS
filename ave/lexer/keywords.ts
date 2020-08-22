import TokenType = require('./tokentype');

// prettier-ignore
const keywords: Map<string, TokenType> = new Map([
  ['and'      , TokenType.AND],
  ['else'     , TokenType.ELSE],
  ['false'    , TokenType.FALSE],
  ['for'      , TokenType.FOR],
  ['fn'       , TokenType.FUNC],
  ['if'       , TokenType.IF],
  ['nil'      , TokenType.NIL],
  ['or'       , TokenType.OR],
  ['var'      , TokenType.VAR],
  ['return'   , TokenType.RETURN],
  ['this'     , TokenType.THIS],
  ['true'     , TokenType.TRUE],
  ['while'    , TokenType.WHILE],
  ['break'    , TokenType.BREAK],
  ['continue' , TokenType.CONTINUE],
  ['static'   , TokenType.STATIC],
  ['class'    , TokenType.CLASS],
  ['enum'     , TokenType.ENUM],
  ['in'       , TokenType.IN],
  ['elif'     , TokenType.ELIF],
  ['switch'   , TokenType.SWITCH],
  ['case'     , TokenType.CASE],
  ['default'  , TokenType.DEFAULT],
  ['const'    , TokenType.CONST],
  ['let'      , TokenType.LET],
  ['fall'     , TokenType.FALL],
  ['to'       , TokenType.TO],
  ['is'       , TokenType.IS],
  ['when'     , TokenType.WHEN],
  ['set'      , TokenType.SET],
  ['get'      , TokenType.GET],
  ['new'      , TokenType.NEW],  
]);

export default keywords;
