import Maid from "@rbxts/maid";
import Signal from "@rbxts/signal";

export class BaseComponent<A = {}, I extends Instance = Instance> {
	/**
	 * A maid that will be destroyed when the component is.
	 */
	public maid = new Maid();

	/**
	 * Attributes attached to this instance.
	 */
	public attributes!: A;

	/**
	 * The instance this component is attached to.
	 * This should only be called in a component lifecycle event.
	 */
	public instance!: I;

	setInstance(instance: I, attributes: unknown) {
		this.instance = instance;
		this.attributes = attributes as never;
	}

	setAttribute<T extends keyof A>(key: T, value: A[T], postfix?: boolean) {
		const previousValue = this.attributes[key];
		this.attributes[key] = value;
		this.instance.SetAttribute(key as string, value as never);
		return postfix ? previousValue : value;
	}

	/** @hidden */
	public _attributeChangeHandlers = new Map<string, Signal<(newValue: unknown, oldValue: unknown) => void>>();

	/**
	 * Connect a callback to the change of a specific attribute.
	 * @param name The name of the attribute
	 * @param cb The callback
	 */
	onAttributeChanged<K extends keyof A>(name: K, cb: (newValue: A[K], oldValue: A[K]) => void) {
		let list = this._attributeChangeHandlers.get(name as string);
		if (!list) this._attributeChangeHandlers.set(name as string, (list = new Signal()));

		return list.Connect(cb as never);
	}

	/**
	 * Destroys this component instance.
	 */
	destroy() {
		this.maid.Destroy();
		for (const [, changeHandler] of this._attributeChangeHandlers) {
			changeHandler.Destroy();
		}
	}
}
