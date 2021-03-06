import {
	AveError,
	AveInfo,
	errorFromToken,
	ErrorReportFn,
	ErrorType,
	makeInfo,
} from "../error/error";
import { throwError, throwInfo } from "../error/reporter";
import Token from "../lexer/token";
import TokenType = require("../lexer/tokentype");
import * as AST from "../parser/ast/ast";
import NodeKind = require("../parser/ast/nodekind");
import { ParsedData } from "../parser/parser";
import Environment from "../parser/symbol_table/environment";
import { DeclarationKind, SymbolData } from "../parser/symbol_table/symtable";
import { HoistedVarDeclaration } from "../type/declaration";
import FunctionType, { ParameterTypeInfo } from "../type/function-type";
import GenericType, { GenericInstance, t_Array } from "../type/generic-type";
import ObjectType, { checkObjectAssignment } from "../type/object-type";
import * as Typing from "../type/types";
import UnionType from "../type/union-type";

export default class Checker {
	private readonly ast: AST.Program;
	private readonly parseData: ParsedData;
	// this stack contains error message "info" that are thrown
	// all at once after an error is reported at some specific
	// location.
	private readonly infoStack: AveInfo[] = [];

	// the root (global) environment.
	// at top level scope
	private rootEnv: Environment = new Environment();
	// current environment being checked, local scope.
	public env: Environment;

	// this stack keeps track of whether or not we
	// are inside a function body. Every time we enter a
	// function body, we push the return type (t_infer
	// if none annotated), every time we exit
	// a function body, pop from it. The stack stores
	// the return types of the functions so it can
	// also be used to determine whether a return statement
	// returns the correct type of expression.
	private functionReturnStack: Typing.Type[] = [];

	// current depth of nested loops.
	// used to determine if break/continue statements
	// are inside loops.
	private loopDepth = 0;

	private reportError: ErrorReportFn;
	private hasError = false;
	private errors: AveError[] = [];

	constructor(parseData: ParsedData, reportErr?: ErrorReportFn) {
		this.ast = parseData.ast;
		this.parseData = parseData;
		this.env = this.rootEnv;
		this.reportError = reportErr || throwError;
	}

	public error(message: string, token: Token, errType: ErrorType = ErrorType.TypeError) {
		const err: AveError = errorFromToken(token, message, this.parseData.fileName, errType);
		this.hasError = true;
		this.errors.push(err);
		this.reportError(err, this.parseData.sourceCode);

		while (this.infoStack.length) {
			throwInfo(this.infoStack.pop() as AveInfo);
		}
	}

	public warn(msg: string) {
		this.infoStack.push(makeInfo(msg, this.parseData.fileName));
	}

	private pushScope() {
		this.env = this.env.extend();
	}

	private popScope() {
		this.env = this.env.pop();
	}

	/**
	 * Checks if the assignment of a type `Tb` to another type `Ta` is valid.
	 * @param   {Typing.Type} ta             Data type of the assignment target
	 * @param   {Typing.Type} tb             Data type of the
	 * @param   {TokenType}   tokenType      assignment operator to use (=, /= , -=, *= etc).
	 *                                          In places like function calls, parameters
	 *                                          are checked using '='.
	 * @returns {boolean}                   `true` if the assignment is valid.
	 */

	private isValidAssignment(ta: Typing.Type, tb: Typing.Type, type = TokenType.EQ): boolean {
		if (type == TokenType.EQ) {
			if (ta instanceof ObjectType) {
				if (!(tb instanceof ObjectType)) return false;
				return checkObjectAssignment(ta, tb, this);
			}

			return ta.canAssign(tb);
		}

		// compound assignment operators (*=, += etc)

		if (type == TokenType.PLUS_EQ)
			return (ta == Typing.t_number && tb == Typing.t_number) || ta == Typing.t_string;

		return ta == Typing.t_any || (ta == Typing.t_number && tb == Typing.t_number);
	}

	/**
	 * "Merges" the types of two statements into a single type.
	 * This function is used for gradual type inferencing of
	 * function bodies. For more information, look at `t__Maybe`
	 * in `"../types/types.ts"`.
	 * @param {Typing.Type} t1 Type of the previous statement.
	 * @param {Typing.Type} t2 Type of the current statement.
	 * @returns {Typing.Type}
	 */
	private mergeTypes(t1: Typing.Type, t2: Typing.Type): Typing.Type {
		// if there is a maybe<T> type, use it as the first
		// argument instead.

		if (t2 instanceof Typing.t__Maybe && !(t1 instanceof Typing.t__Maybe))
			return this.mergeTypes(t2, t1);
		if (t1 instanceof Typing.t__Maybe) {
			if (t2 instanceof Typing.t__Maybe)
				return new Typing.t__Maybe(this.mergeTypes(t1.type, t2.type));
			// if the previous statement was typeless.
			// (having t__notype)
			if (t2 == Typing.t_void) return t1;
			if (t1.type == t2) return t2;
			return new UnionType(t1.type, t2);
		}

		if (t1 == t2) return t1;
		if (t1 == Typing.t_void) return t2;
		if (t2 == Typing.t_void) return t1;

		return new UnionType(t1, t2);
	}

	/**
	 * If argument `t` is a type other than `t_void` then wraps it in a Maybe Type.
	 * @param t {Type} type to check.
	 */
	private checkMaybeType(t: Typing.Type): Typing.Type {
		if (t == Typing.t_void) return t;
		return new Typing.t__Maybe(t);
	}

	/**
	 * Return false if the type of `node` is not equal to `t`. If a third argument
	 * is provided, throws an error.
	 * @param node {AST.Node}    The AST Node whose type is to be matched.
	 * @param type {Typing.Type} The Type to check against.
	 * @param msg  {string}      Error message thrown if the type is mismatched.
	 */
	private assertType(node: AST.Node, type: Typing.Type, msg?: string): boolean {
		const t = this.typeOf(node);

		if (t == type) return true;
		msg = msg || `Expected ${(<Token>node.token).raw} to be of type ${type.toString()}`;

		this.error(msg, <Token>node.token);
		return false;
	}

	check() {
		if (!this.parseData.hasError) {
			this.body(this.ast.body);
		}
		return {
			ast: this.ast,
			errors: this.errors,
			hasError: this.hasError,
		};
	}

	private body(body: AST.Body): Typing.Type {
		this.pushScope();

		// push the declarations of functions,
		// 'var' variables, to the top
		// so we can access them throughout
		// the body.

		for (let decl of body.declarations) {
			decl.defineIn(this.env);
		}

		body.types.forEach((type, name) => {
			this.env.defineType(name, type);
		});

		let type = Typing.t_void;

		for (let stmt of body.statements) {
			type = this.mergeTypes(type, this.statement(stmt));
		}

		this.popScope();

		return type;
	}

	private statement(stmt: AST.Node): Typing.Type {
		switch (stmt.kind) {
			case NodeKind.VarDeclaration:
				this.checkDeclaration(stmt as AST.VarDeclaration);
				return Typing.t_void;
			case NodeKind.IfStmt:
				return this.ifStmt(stmt as AST.IfStmt);
			case NodeKind.ForStmt:
				return this.forStmt(stmt as AST.ForStmt);
			case NodeKind.WhileStmt:
				return this.whileStmt(stmt as AST.WhileStmt);
			case NodeKind.ReturnStmt:
				return this.returnStmt(stmt as AST.ReturnStmt);
			case NodeKind.RecordDeclaration:
			case NodeKind.TypeAlias:
				return Typing.t_void;
			case NodeKind.ExprStmt:
				// just run it through the expression
				// checker to detect type errors.
				this.expression((stmt as AST.ExprStmt).expr);
				// statements have no types
				// (except return statements), so we won't
				// return the type of the expression.
				return Typing.t_void;
			case NodeKind.FunctionDecl:
				return this.functionDeclaration(stmt as AST.FunctionDeclaration);
			default:
				return this.expression(stmt as AST.Expression);
		}
	}

	private checkDeclaration(declNode: AST.VarDeclaration): Typing.Type {
		for (let declartor of declNode.declarators) {
			this.checkDeclarator(declartor, declNode.declarationType);
		}
		return Typing.t_void;
	}

	private checkDeclarator(node: AST.VarDeclarator, kind: DeclarationKind) {
		let type = node.typeInfo.type;
		let currentType = type;

		// check if symbol already exists

		if (this.env.has(node.name)) {
			this.error(`Attempt to redeclare '${node.name}'.`, node.token as Token);
			return;
		}

		let isDefined = false;

		// if the variable has been
		// declared with a value,
		// then infer it's type from that

		if (node.value) {
			currentType = this.typeOf(node.value);
			isDefined = true;
			if (type == Typing.t_infer) type = currentType;
		} else if (type == Typing.t_infer) {
			this.error(
				`'${node.name}' must either be initliazed or type annotated.`,
				node.token as Token
			);
		}

		if (isDefined && !this.isValidAssignment(type, currentType)) {
			this.error(
				`cannot intialize '${
					node.name
				}' of type '${type.toString()}' with type '${currentType.toString()}'`,
				node.token as Token
			);
		}

		const declaration: SymbolData = {
			name: node.name,
			declarationKind: kind,
			dataType: type,
			currentType,
			isDefined,
		};

		this.env.define(node.name, declaration);
	}

	private ifStmt(stmt: AST.IfStmt): Typing.Type {
		const _then = stmt.thenBody;

		let type: Typing.Type = this.checkMaybeType(this.body(_then));

		// TODO check this.
		let condType = this.expression(stmt.condition);

		if (stmt.elseBody) {
			let elseType = this.body(stmt.elseBody);
			type = this.mergeTypes(type, elseType);
		}

		return type;
	}

	// returns the type of an AST.Node, also catches type errors
	// in the process of resolving the type.

	private typeOf(node: AST.Node): Typing.Type {
		return this.statement(node);
	}

	private expression(expr: AST.Expression): Typing.Type {
		switch (expr.kind) {
			case NodeKind.Literal:
				return this.literal(expr.token as Token);
			case NodeKind.BinaryExpr:
				return this.binaryExpr(expr as AST.BinaryExpr);
			case NodeKind.AssignmentExpr:
				return this.assignment(expr as AST.AssignExpr);
			case NodeKind.Identifier:
				return this.identifier(expr as AST.Identifier);
			case NodeKind.GroupingExpr:
				return this.typeOf((expr as AST.GroupExpr).expr);
			case NodeKind.PrefixUnaryExpr:
			case NodeKind.PostfixUnaryExpr:
				return this.unary(expr as AST.PostfixUnaryExpr);
			case NodeKind.ArrayExpr:
				return this.array(expr as AST.ArrayExpr);
			case NodeKind.CallExpr:
				return this.callExpr(expr as AST.CallExpr);
			case NodeKind.FunctionExpr:
				return this.funcExpr(expr as AST.FunctionExpr);
			case NodeKind.ObjectExpr:
				return this.objectExpr(expr as AST.ObjectExpr);
			case NodeKind.MemberAcessExpr:
				return this.memberExpression(expr as AST.MemberAccessExpr);
		}
		return Typing.t_error;
	}

	private literal(token: Token): Typing.Type {
		switch (token.type) {
			case TokenType.LITERAL_NUM:
			case TokenType.LITERAL_HEX:
			case TokenType.LITERAL_BINARY:
				return Typing.t_number;
			case TokenType.LITERAL_STR:
				return Typing.t_string;
			case TokenType.TRUE:
			case TokenType.FALSE:
				return Typing.t_bool;
			case TokenType.NIL:
				return Typing.t_nil;
			default:
				return Typing.t_any;
		}
	}

	private identifier(id: AST.Identifier): Typing.Type {
		const name: string = id.name;
		const symbolData = this.env.find(name);

		if (symbolData) {
			// if the data type is a free type,
			// return t_any instead.
			return symbolData.dataType;
		}

		this.error(`Cannot find name ${name}.`, id.token as Token, ErrorType.ReferenceError);

		return Typing.t_error;
	}

	private binaryExpr(expr: AST.BinaryExpr): Typing.Type {
		const operator = expr.operator.type;

		const lType = this.typeOf(expr.left);
		const rType = this.typeOf(expr.right);

		const type = Typing.binaryOp(lType, operator, rType);

		if (
			type == Typing.t_error &&
			// don't report error if one already has been reported in this region.
			lType != Typing.t_error &&
			rType != Typing.t_error
		) {
			this.error(
				`Cannot use operator '${expr.operator.raw}' on operands of type '${lType}' and '${rType}'.`,
				expr.operator
			);
		}

		return type;
	}

	private assignment(node: AST.AssignExpr): Typing.Type {
		const left = node.left;
		const right = node.right;

		if (!this.isValidAssignTarget(left)) return Typing.t_error;

		const lType = this.typeOf(left);
		const rType = this.typeOf(right);

		// if the left or right side is erratic
		// and error has already been reported
		// and there is no need to report again.
		if (lType == Typing.t_error || rType == Typing.t_error) return rType;

		if (!this.isValidAssignment(lType, rType, node.operator.type)) {
			let message =
				node.operator.type == TokenType.EQ
					? `Cannot assign type '${rType.toString()}' to type '${lType.toString()}'.`
					: `Cannot use operator '${
							node.operator.raw
					  }' on operand types '${rType.toString()}' and '${lType.toString()}'`;

			this.error(message, node.operator);
		}

		return rType;
	}

	private isValidAssignTarget(node: AST.Node): boolean {
		switch (node.kind) {
			case NodeKind.Identifier:
				const name = (node as AST.Identifier).name;
				const symbolData = this.env.find(name);

				// check for undefined name
				if (!symbolData) {
					this.error(`Cannot find name '${name}'`, node.token as Token, ErrorType.ReferenceError);
					return false;
				}

				// check for assignment to constant
				if (symbolData.declarationKind == DeclarationKind.Constant) {
					this.error(`Invalid assignment to constant '${name}'`, node.token as Token);
					return false;
				}
				return true;
			case NodeKind.MemberAcessExpr:
				// TODO
				return true;
			default:
				return false;
		}
	}

	private unary(expr: AST.PrefixUnaryExpr | AST.PostfixUnaryExpr): Typing.Type {
		const tOperand = this.typeOf(expr.operand);

		if (tOperand == Typing.t_error) return Typing.t_error;
		const type = Typing.unaryOp(expr.operator.type, tOperand);

		if (type == Typing.t_error) {
			const message = `Cannot apply operator '${
				expr.operator.raw
			} on operand of type '${tOperand.toString()}''`;
			this.error(message, expr.operator);
			return Typing.t_error;
		}

		return type;
	}

	private array(arr: AST.ArrayExpr): Typing.Type {
		if (arr.elements.length == 0) return t_Array.instantiate([Typing.t_bottom]);

		let type = this.typeOf(arr.elements[0]);

		for (let el of arr.elements) {
			const t = this.typeOf(el);
			if (t == Typing.t_error) return Typing.t_error;
			if (t != type) return t_Array.instantiate([Typing.t_any]);
		}

		return t_Array.instantiate([type]);
	}

	private callExpr(expr: AST.CallExpr): Typing.Type {
		let callee = expr.callee;
		let type = this.expression(expr.callee);
		let args = expr.args;

		if (!(type instanceof FunctionType)) {
			this.error(`Function does not exist.`, callee.token as Token, ErrorType.ReferenceError);
			return Typing.t_undef;
		}

		if (type.returnType == Typing.t_infer) {
			this.error(
				`function requires explicit type annotation, or must be defined before use.`,
				callee.operator
			);
			return Typing.t_error;
		}

		this.verifyArguments(args, (type as FunctionType).params);
		return type.returnType;
	}

	private verifyArguments(args: AST.Expression[], params: ParameterTypeInfo[]) {
		let i = 0;
		for (; i < params.length; i++) {
			if (!args[i]) {
				if (params[i].required) {
					this.error(
						`Missing argument '${params[i].name}' to function call.`,
						args[i - 1].token as Token
					);
				}
				return;
			}

			let argumentType = this.expression(args[i]);

			if (!this.isValidAssignment(params[i].type, argumentType)) {
				this.error(
					`cannot assign argument of type '${argumentType.toString()}' to parameter of type '${params[
						i
					].type.toString()}'.`,
					args[i].token as Token
				);
			}
		}

		// unexpected argument
		if (args[i]) {
			let ord = "th";
			let digit = (i + 1) % 10;
			if (digit == 2) ord = "nd";
			else if (digit == 3) ord = "rd";
			else if (digit == 1) ord = "st";
			this.error(`Unexpected ${digit}${ord} argument to function call.`, args[i].operator);
		}
	}

	private objectExpr(obj: AST.ObjectExpr): ObjectType {
		let t_object = new ObjectType("");

		obj.kvPairs.forEach((val: AST.Expression, key: Token) => {
			t_object.defineProperty(key.raw, this.expression(val));
		});

		return t_object;
	}

	private memberExpression(expr: AST.MemberAccessExpr) {
		const lType = this.expression(expr.object);
		const property = expr.property;

		if (expr.isIndexed) {
			throw new Error("Cannot index yet.");
		} else if (property instanceof AST.Identifier) {
			// if property key does not exist on type of
			// the object, throw an error.
			if (!lType.hasProperty(property.name))
				this.error(
					`property '${property.name}' does not exist on type ${lType}`,
					property.operator
				);

			const expType = lType.getProperty(property.name) as Typing.Type;
			return expType;
		} else {
			throw new Error("impossible condition encountered.");
		}
	}

	private forStmt(forStmt: AST.ForStmt): Typing.Type {
		this.assertType(forStmt.start, Typing.t_number, "loop start must be a number.");

		this.assertType(forStmt.stop, Typing.t_number, "loop limit must be a number.");

		if (forStmt.step) {
			this.assertType(forStmt.step, Typing.t_number, "loop step must be a number.");
		}

		let type = this.body(forStmt.body);
		return this.checkMaybeType(type);
	}

	private whileStmt(stmt: AST.WhileStmt): Typing.Type {
		this.expression(stmt.condition);
		const type = this.body(stmt.body);
		return this.checkMaybeType(type);
	}

	private returnStmt(stmt: AST.ReturnStmt): Typing.Type {
		let type = Typing.t_undef;
		if (stmt.expr) type = this.expression(stmt.expr);

		let rtype = this.functionReturnStack[this.functionReturnStack.length - 1];

		if (!rtype) {
			this.error(`return statement outside function.`, stmt.token as Token, ErrorType.SyntaxError);
			return type;
		}

		if (rtype == Typing.t_infer) return type;

		if (!this.isValidAssignment(rtype, type, TokenType.EQ))
			this.error(
				`Incorrect return type '${type}'. Expected value of type '${rtype}'`,
				stmt.expr?.token as Token
			);

		return type;
	}

	private functionDeclaration(func: AST.FunctionDeclaration): Typing.Type {
		return this.funcExpr(func.lambda);
	}

	private funcExpr(func: AST.FunctionExpr) {
		this.verifyFunctionParams(func.params);

		this.functionReturnStack.push(func.returnTypeInfo.type);

		let paramTypeInfo: ParameterTypeInfo[] = [];

		func.params.forEach(param => {
			func.body.declarations.push(new HoistedVarDeclaration(param.name, param.typeInfo.type));
			paramTypeInfo.push({
				name: param.name,
				type: param.typeInfo.type,
				required: !!param.required,
			});
		});

		let returnType = this.body(func.body);

		// if there was no return statement
		// anywhere inside the function's body,
		// it has a return type of undefined.

		if (returnType == Typing.t_void) returnType = Typing.t_undef;

		let annotatedType = func.returnTypeInfo.type;

		if (annotatedType == Typing.t_infer) func.returnTypeInfo.type = returnType;

		if (!this.isValidAssignment(func.returnTypeInfo.type, returnType))
			this.error(
				`Function's type annotation is '${func.returnTypeInfo.type}' but return type is ${returnType}.`,
				func.token as Token
			);

		this.functionReturnStack.pop();
		return new FunctionType("", paramTypeInfo, returnType);
	}

	// TODO handle optional parameters
	private verifyFunctionParams(params: AST.FunctionParam[]) {
		for (let i = 0; i < params.length; i++) {
			// default value must be assignable to annotated type.
			if (params[i].defaultValue) {
				let type = this.expression(params[i].defaultValue as AST.Expression);

				let annotatedType = params[i].typeInfo.type;
				if (!this.isValidAssignment(annotatedType, type)) {
					this.error(
						`Cannot assign value of type '${type.toString()}' to paramter of type '${params[
							i
						].typeInfo.toString()}'`,
						params[i].token
					);
					return false;
				}
			}
		}
		return true;
	}
}
