import Maid from "@rbxts/maid";
import { CollectionService, RunService } from "@rbxts/services";
import { t } from "@rbxts/t";
import { Service, Controller, OnInit, Flamework, OnStart, OnTick, OnPhysics, OnRender, Reflect } from "@flamework/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClassDecorator = (ctor: any) => any;
type Constructor<T = unknown> = new (...args: never[]) => T;

interface ComponentInfo {
	ctor: Constructor<BaseComponent>;
	identifier: string;
	config: Flamework.ConfigType<"Component">;
}

/**
 * Register a class as a Component.
 */
export declare function Component(opts?: Flamework.ComponentConfig): ClassDecorator;

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
		this.instance.SetAttribute(key as string, value);
		return postfix ? previousValue : value;
	}

	/** @hidden */
	public _attributeChangeHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

	/**
	 * Connect a callback to the change of a specific attribute.
	 * @param name The name of the attribute
	 * @param cb The callback
	 */
	onAttributeChanged<K extends keyof A>(name: K, cb: (newValue: A[K], oldValue: A[K]) => void) {
		let list = this._attributeChangeHandlers.get(name as string);
		if (!list) this._attributeChangeHandlers.set(name as string, (list = []));

		list.push(cb as never);
	}

	/**
	 * Destroys this component instance.
	 */
	destroy() {
		this.maid.Destroy();
	}
}

/**
 * This class is responsible for loading and managing
 * all components in the game.
 */
@Service({
	loadOrder: 0,
})
@Controller({
	loadOrder: 0,
})
export class Components implements OnInit, OnStart, OnTick, OnPhysics, OnRender {
	private components = new Map<Constructor, ComponentInfo>();
	private activeComponents = new Map<Instance, Map<unknown, BaseComponent>>();

	private tick = new Set<BaseComponent & OnTick>();
	private physics = new Set<BaseComponent & OnPhysics>();
	private render = new Set<BaseComponent & OnRender>();

	onInit() {
		const components = new Map<Constructor, ComponentInfo>();
		for (const [ctor, identifier] of Reflect.objToId) {
			const component = Reflect.getOwnMetadata<Flamework.ConfigType<"Component">>(
				ctor,
				`flamework:decorators.${Flamework.id<typeof Component>()}`,
			);

			if (component) {
				components.set(ctor as Constructor, {
					ctor: ctor as Constructor<BaseComponent>,
					config: component,
					identifier,
				});
			}
		}
		this.components = components;
	}

	onStart() {
		for (const [, { config, ctor, identifier }] of this.components) {
			if (config.tag !== undefined) {
				const instanceGuard = this.getInstanceGuard(ctor);
				const addConnections = new Map<Instance, RBXScriptConnection>();
				const removeConnections = new Map<Instance, RBXScriptConnection>();

				const setupAddedConnection = (instance: Instance) => {
					const connection = instance.DescendantAdded.Connect(() => {
						if (instanceGuard!(instance)) {
							this.addComponent(instance, ctor, true);

							connection.Disconnect();
							addConnections.delete(instance);
							setupRemovedConnection(instance);
						}
					});
					addConnections.set(instance, connection);
				};

				const setupRemovedConnection = (instance: Instance) => {
					const connection = instance.DescendantRemoving.Connect(() => {
						// The parent does not change until the next frame, so the guard will
						// always succeed unless we yield.
						RunService.Heartbeat.Wait();

						if (!instanceGuard!(instance)) {
							this.removeComponent(instance, ctor);

							connection.Disconnect();
							removeConnections.delete(instance);
							setupAddedConnection(instance);
						}
					});
					removeConnections.set(instance, connection);
				};

				const instanceAdded = (instance: Instance) => {
					if (RunService.IsServer()) {
						return this.addComponent(instance, ctor);
					}

					if (!instanceGuard || instanceGuard(instance)) {
						this.addComponent(instance, ctor, true);
						setupRemovedConnection(instance);
					} else {
						setupAddedConnection(instance);
					}
				};

				CollectionService.GetInstanceAddedSignal(config.tag).Connect(instanceAdded);
				CollectionService.GetInstanceRemovedSignal(config.tag).Connect((instance) => {
					const addConnection = addConnections.get(instance);
					const removeConnection = removeConnections.get(instance);

					addConnections.delete(instance);
					removeConnections.delete(instance);

					addConnection?.Disconnect();
					removeConnection?.Disconnect();

					this.removeComponent(instance, ctor);
				});

				for (const instance of CollectionService.GetTagged(config.tag)) {
					this.safeCall(`Failed to instantiate '${identifier}' for ${instance}`, () =>
						instanceAdded(instance),
					);
				}
			}
		}
	}

	onTick(dt: number) {
		for (const component of this.tick) {
			const name = component.instance.GetFullName();
			const id = Reflect.getMetadata<string>(component, "identifier");
			this.safeCall(`Component '${id}' failed to tick ${name}`, () => component.onTick(dt));
		}
	}

	onRender(dt: number) {
		for (const component of this.render) {
			const name = component.instance.GetFullName();
			const id = Reflect.getMetadata<string>(component, "identifier");
			this.safeCall(`Component '${id}' failed to render ${name}`, () => component.onRender(dt));
		}
	}

	onPhysics(dt: number, time: number) {
		for (const component of this.physics) {
			const name = component.instance.GetFullName();
			const id = Reflect.getMetadata<string>(component, "identifier");
			this.safeCall(`Component '${id}' failed to step ${name}`, () => component.onPhysics(dt, time));
		}
	}

	private getAttributeGuards(ctor: Constructor) {
		const attributes = new Map<string, t.check<unknown>>();
		const metadata = this.components.get(ctor);
		if (metadata) {
			if (metadata.config.attributes !== undefined) {
				for (const [attribute, guard] of pairs(metadata.config.attributes)) {
					attributes.set(attribute as string, guard);
				}
			}
			const parentCtor = getmetatable(ctor) as { __index?: Constructor };
			if (parentCtor.__index !== undefined) {
				for (const [attribute, guard] of this.getAttributeGuards(parentCtor.__index as Constructor)) {
					if (!attributes.has(attribute)) {
						attributes.set(attribute, guard);
					}
				}
			}
		}
		return attributes;
	}

	private getAttributes(instance: Instance, componentInfo: ComponentInfo, guards: Map<string, t.check<unknown>>) {
		const attributes = instance.GetAttributes() as Map<string, unknown>;
		const newAttributes = new Map<string, unknown>();
		const defaults = componentInfo.config.defaults;

		for (const [key, guard] of pairs(guards)) {
			const attribute = attributes.get(key);
			if (!guard(attribute)) {
				if (defaults?.[key] !== undefined) {
					newAttributes.set(key, defaults[key]);
				} else {
					throw `${instance.GetFullName()} has invalid attribute '${key}' for '${componentInfo.identifier}'`;
				}
			} else {
				newAttributes.set(key, attribute);
			}
		}

		return newAttributes;
	}

	private getInstanceGuard(ctor: Constructor): t.check<unknown> | undefined {
		const metadata = this.components.get(ctor);
		if (metadata) {
			if (metadata.config.instanceGuard !== undefined) {
				return metadata.config.instanceGuard;
			}
			const parentCtor = getmetatable(ctor) as { __index?: Constructor };
			if (parentCtor.__index !== undefined) {
				return this.getInstanceGuard(parentCtor.__index);
			}
		}
	}

	private safeCall(message: string, func: () => void) {
		coroutine.wrap(() => {
			xpcall(func, (err) => {
				if (typeIs(err, "string")) {
					const stack = debug.traceback(err, 2);
					warn(message);
					warn(stack);
				} else {
					warn(message);
					warn(err);
					warn(debug.traceback(undefined, 2));
				}
			});
		})();
	}

	private setupComponent(
		instance: Instance,
		attributes: Map<string, unknown>,
		component: BaseComponent,
		{ config, ctor, identifier }: ComponentInfo,
	) {
		component.setInstance(instance, attributes);

		if (Flamework.implements<OnStart>(component)) {
			const name = instance.GetFullName();
			this.safeCall(`Component '${identifier}' failed to start ${name}`, () => component.onStart());
		}

		if (Flamework.implements<OnRender>(component)) {
			this.render.add(component);
			component.maid.GiveTask(() => this.render.delete(component));
		}

		if (Flamework.implements<OnPhysics>(component)) {
			this.physics.add(component);
			component.maid.GiveTask(() => this.physics.delete(component));
		}

		if (Flamework.implements<OnTick>(component)) {
			this.tick.add(component);
			component.maid.GiveTask(() => this.tick.delete(component));
		}

		if (config.refreshAttributes === undefined || config.refreshAttributes) {
			const attributes = this.getAttributeGuards(ctor);
			for (const [attribute, guard] of pairs(attributes)) {
				if (typeIs(attribute, "string")) {
					component.maid.GiveTask(
						instance.GetAttributeChangedSignal(attribute).Connect(() => {
							const handlers = component._attributeChangeHandlers.get(attribute);
							const value = instance.GetAttribute(attribute);
							const attributes = component.attributes as Map<string, unknown>;
							if (guard(value)) {
								if (handlers) {
									for (const handler of handlers) {
										this.safeCall(
											`Component '${identifier}' failed to call onAttributeChanged for ${attribute}`,
											() => handler(value, attributes.get(attribute)),
										);
									}
								}
								attributes.set(attribute, value);
							}
						}),
					);
				}
			}
		}
	}

	private getComponentFromSpecifier<T extends Constructor>(componentSpecifier?: T | string) {
		return typeIs(componentSpecifier, "string")
			? (Reflect.idToObj.get(componentSpecifier) as T)
			: componentSpecifier;
	}

	getComponent<T>(instance: Instance): T;
	getComponent<T>(instance: Instance, componentSpecifier: Constructor<T>): T;
	getComponent<T>(instance: Instance, componentSpecifier?: Constructor<T> | string) {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		const activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) return;

		return activeComponents.get(component);
	}

	/** @internal */
	addComponent<T>(instance: Instance, componentSpecifier: Constructor<T>, skipInstanceCheck: true): T;
	addComponent<T>(instance: Instance): T;
	addComponent<T>(instance: Instance, componentSpecifier: Constructor<T>): T;
	addComponent<T extends BaseComponent>(
		instance: Instance,
		componentSpecifier?: Constructor<T> | string,
		skipInstanceCheck?: boolean,
	) {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		const componentInfo = this.components.get(component);
		assert(componentInfo, "Provided componentSpecifier does not exist");

		const attributeGuards = this.getAttributeGuards(component);
		const attributes = this.getAttributes(instance, componentInfo, attributeGuards);

		if (skipInstanceCheck !== true) {
			const instanceGuard = this.getInstanceGuard(component);
			if (instanceGuard !== undefined) {
				assert(
					instanceGuard(instance),
					`${instance.GetFullName()} did not pass instance guard check for '${componentInfo.identifier}'`,
				);
			}
		}

		let activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) this.activeComponents.set(instance, (activeComponents = new Map()));

		const existingComponent = activeComponents.get(component);
		if (existingComponent !== undefined) return existingComponent;

		const componentInstance = Flamework.createDependency(component) as T;
		activeComponents.set(component, componentInstance);

		this.setupComponent(instance, attributes, componentInstance, componentInfo);
		return componentInstance;
	}

	removeComponent<T>(instance: Instance): void;
	removeComponent<T>(instance: Instance, componentSpecifier: Constructor<BaseComponent>): void;
	removeComponent(instance: Instance, componentSpecifier?: Constructor<BaseComponent> | string) {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		const activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) return;

		const existingComponent = activeComponents.get(component);
		if (!existingComponent) return;

		existingComponent.destroy();
		activeComponents.delete(component);

		if (activeComponents.size() === 0) {
			this.activeComponents.delete(instance);
		}
	}
}
