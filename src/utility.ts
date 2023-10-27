import { Modding, Reflect } from "@flamework/core";

export type Constructor<T = object> = new (...args: never[]) => T;
export type AbstractConstructor<T = object> = abstract new (...args: never[]) => T;

export type ConstructorRef<T> = Constructor<T> | Modding.Generic<T, "id"> | string;
export type AbstractConstructorRef<T> = AbstractConstructor<T> | Modding.Generic<T, "id"> | string;

export function isConstructor(obj: object): obj is Constructor {
	return "constructor" in obj && "new" in obj;
}

export function getParentConstructor(ctor: AbstractConstructor) {
	const metatable = getmetatable(ctor) as { __index?: object };
	if (metatable && typeIs(metatable, "table")) {
		const parentConstructor = rawget(metatable, "__index") as AbstractConstructor;
		return parentConstructor;
	}
}

export function safeCall(message: unknown[], func: () => void, printStack = true) {
	task.spawn(() => {
		xpcall(func, (err) => {
			if (typeIs(err, "string") && printStack) {
				const stack = debug.traceback(err, 2);
				warn(...message);
				warn(stack);
			} else {
				warn(...message);
				warn(err);
				if (printStack) warn(debug.traceback(undefined, 2));
			}
		});
	});
}

export function getComponentFromSpecifier<T extends AbstractConstructorRef<unknown>>(componentSpecifier?: T) {
	return typeIs(componentSpecifier, "string")
		? (Modding.getObjectFromId(componentSpecifier) as Extract<T, AbstractConstructor>)
		: (componentSpecifier as Extract<T, AbstractConstructor>);
}

export function getIdFromSpecifier<T extends AbstractConstructor>(componentSpecifier?: T | string) {
	if (componentSpecifier !== undefined) {
		return typeIs(componentSpecifier, "string")
			? componentSpecifier
			: Reflect.getMetadata<string>(componentSpecifier, "identifier");
	}
}
