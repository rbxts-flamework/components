import Maid from "@rbxts/maid";
import { CollectionService, RunService } from "@rbxts/services";
import { t } from "@rbxts/t";
import { Service, Controller, OnInit, Flamework, OnStart, Reflect, Modding } from "@flamework/core";

type Constructor<T = unknown> = new (...args: never[]) => T;

interface ComponentInfo {
	ctor: Constructor<BaseComponent>;
	identifier: string;
	config: ComponentConfig;
}

export interface ComponentConfig {
	tag?: string;
	attributes?: { [key: string]: t.check<unknown> };
	defaults?: { [key: string]: unknown };
	instanceGuard?: t.check<unknown>;
	refreshAttributes?: boolean;
}

/**
 * Register a class as a Component.
 *
 * @metadata flamework:implements flamework:parameters
 */
export const Component = Modding.createMetaDecorator<[opts?: ComponentConfig]>("Class");

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
export class Components implements OnInit, OnStart {
	private components = new Map<Constructor, ComponentInfo>();
	private classParentCache = new Map<Constructor, readonly Constructor[]>();

	private activeComponents = new Map<Instance, Map<unknown, BaseComponent>>();
	private activeInheritedComponents = new Map<Instance, Map<string, Set<BaseComponent>>>();
	private reverseComponentsMapping = new Map<string, Set<BaseComponent>>();

	onInit() {
		const components = new Map<Constructor, ComponentInfo>();
		const componentConstructors = Modding.getDecorators<typeof Component>();
		for (const { object: ctor, arguments: args } of componentConstructors) {
			const identifier = Reflect.getMetadata<string>(ctor, "identifier")!;
			components.set(ctor as Constructor, {
				ctor: ctor as Constructor<BaseComponent>,
				config: args[0] || {},
				identifier,
			});
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
					if (RunService.IsServer() || !instanceGuard) {
						return this.addComponent(instance, ctor);
					}

					if (instanceGuard(instance)) {
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

	private getParentConstructor(ctor: Constructor) {
		const metatable = getmetatable(ctor) as { __index?: object };
		if (metatable && typeIs(metatable, "table")) {
			const parentConstructor = rawget(metatable, "__index") as Constructor;
			return parentConstructor;
		}
	}

	private getOrderedParents(ctor: Constructor, omitBaseComponent = true) {
		const cache = this.classParentCache.get(ctor);
		if (cache) return cache;

		const classes = [ctor];
		let nextParent: Constructor | undefined = ctor;
		while ((nextParent = this.getParentConstructor(nextParent)) !== undefined) {
			if (!omitBaseComponent || nextParent !== BaseComponent) {
				classes.push(nextParent);
			}
		}

		this.classParentCache.set(ctor, classes);
		return classes;
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
					instance.SetAttribute(key, defaults[key]);
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
		task.spawn(() => {
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
		});
	}

	private setupComponent(
		instance: Instance,
		attributes: Map<string, unknown>,
		component: BaseComponent,
		construct: () => void,
		{ config, ctor, identifier }: ComponentInfo,
	) {
		component.setInstance(instance, attributes);
		construct();

		if (Flamework.implements<OnStart>(component)) {
			const name = instance.GetFullName();
			this.safeCall(`Component '${identifier}' failed to start ${name}`, () => component.onStart());
		}

		Modding.addListener(component);
		component.maid.GiveTask(() => Modding.removeListener(component));

		if (config.refreshAttributes === undefined || config.refreshAttributes) {
			const attributeCache = table.clone(attributes);
			const attributeGuards = this.getAttributeGuards(ctor);
			for (const [attribute, guard] of pairs(attributeGuards)) {
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
											() => handler(value, attributeCache.get(attribute)),
										);
									}
								}
								attributes.set(attribute, value);
								attributeCache.set(attribute, value);
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

	private getIdFromSpecifier<T extends Constructor>(componentSpecifier?: T | string) {
		if (componentSpecifier !== undefined) {
			return typeIs(componentSpecifier, "string")
				? componentSpecifier
				: Reflect.getMetadata<string>(componentSpecifier, "identifier");
		}
	}

	private addIdMapping(value: BaseComponent, id: string, inheritedComponents: Map<string, Set<BaseComponent>>) {
		let instances = inheritedComponents.get(id);
		if (!instances) inheritedComponents.set(id, (instances = new Set()));

		let inheritedLookup = this.reverseComponentsMapping.get(id);
		if (!inheritedLookup) this.reverseComponentsMapping.set(id, (inheritedLookup = new Set()));

		instances.add(value);
		inheritedLookup.add(value);
	}

	private removeIdMapping(instance: Instance, value: BaseComponent, id: string) {
		const inheritedComponents = this.activeInheritedComponents.get(instance);
		if (!inheritedComponents) return;

		const instances = inheritedComponents.get(id);
		if (!instances) return;

		const inheritedLookup = this.reverseComponentsMapping.get(id);
		if (!inheritedLookup) return;

		instances.delete(value);
		inheritedLookup.delete(value);

		if (inheritedLookup.size() === 0) {
			this.reverseComponentsMapping.delete(id);
		}

		if (instances.size() === 0) {
			inheritedComponents.delete(id);
		}

		if (inheritedComponents.size() === 0) {
			this.activeInheritedComponents.delete(instance);
		}
	}

	getComponent<T>(instance: Instance): T | undefined;
	getComponent<T>(instance: Instance, componentSpecifier: Constructor<T> | string): T | undefined;
	getComponent<T>(instance: Instance, componentSpecifier?: Constructor<T> | string) {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		const activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) return;

		return activeComponents.get(component);
	}

	getComponents<T>(instance: Instance): T[];
	getComponents<T>(instance: Instance, componentSpecifier: Constructor<T> | string): T[];
	getComponents<T>(instance: Instance, componentSpecifier?: Constructor<T> | string): T[] {
		const componentIdentifier = this.getIdFromSpecifier(componentSpecifier);
		if (componentIdentifier === undefined) return [];

		const activeComponents = this.activeInheritedComponents.get(instance);
		if (!activeComponents) return [];

		const componentsSet = activeComponents.get(componentIdentifier);
		if (!componentsSet) return [];

		return [...componentsSet] as never;
	}

	/** @internal */
	addComponent<T>(instance: Instance, componentSpecifier: Constructor<T>, skipInstanceCheck: true): T;
	addComponent<T>(instance: Instance): T;
	addComponent<T>(instance: Instance, componentSpecifier: Constructor<T> | string): T;
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

		let inheritedComponents = this.activeInheritedComponents.get(instance);
		if (!inheritedComponents) this.activeInheritedComponents.set(instance, (inheritedComponents = new Map()));

		const existingComponent = activeComponents.get(component);
		if (existingComponent !== undefined) return existingComponent;

		const [componentInstance, construct] = Modding.createDeferredDependency(component);
		activeComponents.set(component, componentInstance);

		for (const parentClass of this.getOrderedParents(component)) {
			const parentId = Reflect.getOwnMetadata<string>(parentClass, "identifier");
			if (parentId === undefined) continue;

			this.addIdMapping(componentInstance, parentId, inheritedComponents);
		}

		const implementedList = Reflect.getMetadatas<string[]>(component, "flamework:implements");
		for (const implemented of implementedList) {
			for (const id of implemented) {
				this.addIdMapping(componentInstance, id, inheritedComponents);
			}
		}

		this.setupComponent(instance, attributes, componentInstance, construct, componentInfo);
		return componentInstance;
	}

	removeComponent<T>(instance: Instance): void;
	removeComponent<T>(instance: Instance, componentSpecifier: Constructor<BaseComponent> | string): void;
	removeComponent(instance: Instance, componentSpecifier?: Constructor<BaseComponent> | string) {
		const component = this.getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		const activeComponents = this.activeComponents.get(instance);
		if (!activeComponents) return;

		const existingComponent = activeComponents.get(component);
		if (!existingComponent) return;

		existingComponent.destroy();
		activeComponents.delete(component);

		for (const parentClass of this.getOrderedParents(component)) {
			const parentId = Reflect.getOwnMetadata<string>(parentClass, "identifier");
			if (parentId === undefined) continue;

			this.removeIdMapping(instance, existingComponent, parentId);
		}

		const implementedList = Reflect.getMetadatas<string[]>(component, "flamework:implements");
		for (const implemented of implementedList) {
			for (const id of implemented) {
				this.removeIdMapping(instance, existingComponent, id);
			}
		}

		if (activeComponents.size() === 0) {
			this.activeComponents.delete(instance);
		}
	}

	getAllComponents<T>(): T[];
	getAllComponents<T>(componentSpecifier: Constructor<T> | string): T[];
	getAllComponents<T>(componentSpecifier?: Constructor<T> | string): T[] {
		const componentIdentifier = this.getIdFromSpecifier(componentSpecifier);
		if (componentIdentifier === undefined) return [];

		const reverseMapping = this.reverseComponentsMapping.get(componentIdentifier);
		if (!reverseMapping) return [];

		return [...reverseMapping] as never;
	}
}
