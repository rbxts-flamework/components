import { Controller, Flamework, Modding, OnInit, OnStart, Reflect, Service } from "@flamework/core";
import { CollectionService, ReplicatedStorage, RunService, ServerStorage } from "@rbxts/services";
import { t } from "@rbxts/t";
import { BaseComponent, SYMBOL_ATTRIBUTE_HANDLERS } from "./baseComponent";
import { ComponentTracker } from "./componentTracker";
import {
	AbstractConstructor,
	Constructor,
	getComponentFromSpecifier,
	getIdFromSpecifier,
	getParentConstructor,
	isConstructor,
	safeCall,
} from "./utility";

interface ComponentInfo {
	ctor: Constructor<BaseComponent>;
	componentDependencies: Constructor[];
	identifier: string;
	config: ComponentConfig;
}

/**
 * This enum dictates how component instance guards interact with StreamingEnabled.
 */
export enum ComponentStreamingMode {
	/**
	 * This disables instance guard streaming, and will only run the instance guard once.
	 */
	Disabled,

	/**
	 * This will watch for any changes to the instance tree, and rerun the instance guards.
	 */
	Watching,

	/**
	 * This determines the appropriate streaming mode based on a couple of factors.
	 *
	 * If on the server, this will always behave like `Disabled`.
	 *
	 * If on the client, and the attached instance is an `Atomic` model, this will behave like `Disabled`.
	 *
	 * Otherwise, this behaves like `Watching`.
	 */
	Contextual,

	/**
	 * This is equivalent to {@link ComponentStreamingMode.Contextual Contextual}.
	 */
	Default = Contextual,
}

export interface ComponentConfig {
	/**
	 * The CollectionService tag this component is associated with.
	 */
	tag?: string;

	/**
	 * Override guards for specified attributes.
	 */
	attributes?: { [key: string]: t.check<unknown> };

	/**
	 * By default, Flamework will not construct components which do not pass the specified attribute guards.
	 * You can specify default values which Flamework will use instead of cancelling the component's construction.
	 */
	defaults?: { [key: string]: unknown };

	/**
	 * Overrides the guard generated by Flamework to validate instance trees.
	 */
	instanceGuard?: t.check<unknown>;

	/**
	 * Should this instance be ignored?
	 *
	 * This property differs from `instanceGuard` because it cancels the CollectionService event,
	 * whereas `instanceGuard` may continue to fire, along with other checks.
	 */
	predicate?: (instance: Instance) => boolean;

	/**
	 * Should this component watch for changes to attributes?
	 *
	 * This will disable `onAttributeChanged` events in the component, as well.
	 */
	refreshAttributes?: boolean;

	/**
	 * Specifies where components can be constructed via CollectionService.
	 * This has higher priority than `ancestorBlacklist`, including the default blacklist.
	 *
	 * This has the same behavior as a predicate.
	 */
	ancestorWhitelist?: Instance[];

	/**
	 * Specifies where components can not be constructed via CollectionService.
	 * Defaults to ServerStorage and ReplicatedStorage.
	 *
	 * This has the same behavior as a predicate.
	 */
	ancestorBlacklist?: Instance[];

	/**
	 * Flamework will warn whenever a component isn't able to be created while watching for CollectionService tags,
	 * this allows you to adjust how long until that warning appears.
	 *
	 * Defaults to 5, set to 0 to disable.
	 */
	warningTimeout?: number;

	/**
	 * Override the component streaming mode, defaults to `Contextual`.
	 */
	streamingMode?: ComponentStreamingMode;
}

const DEFAULT_ANCESTOR_BLACKLIST = [ServerStorage, ReplicatedStorage];

/**
 * Register a class as a Component.
 *
 * @metadata flamework:implements flamework:parameters injectable
 */
export const Component = Modding.createMetaDecorator<[opts?: ComponentConfig]>("Class");

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
	private classParentCache = new Map<AbstractConstructor, readonly AbstractConstructor[]>();

	private activeComponents = new Map<Instance, Map<unknown, BaseComponent>>();
	private activeInheritedComponents = new Map<Instance, Map<string, Set<BaseComponent>>>();
	private reverseComponentsMapping = new Map<string, Set<BaseComponent>>();

	private trackers = new Map<Constructor, ComponentTracker>();
	private componentWaiters = new Map<Instance, Map<Constructor, Set<(value: unknown) => void>>>();

	onInit() {
		const components = new Map<Constructor, ComponentInfo>();
		const componentConstructors = Modding.getDecorators<typeof Component>();
		for (const { constructor: ctor, arguments: args } of componentConstructors) {
			if (ctor === undefined) {
				continue;
			}

			const identifier = Reflect.getMetadata<string>(ctor, "identifier")!;
			const componentDependencies = new Array<Constructor>();
			const parameters = Reflect.getMetadata<string[]>(ctor, "flamework:parameters");
			if (parameters) {
				for (const dependency of parameters) {
					const object = Reflect.idToObj.get(dependency);
					if (!object || !isConstructor(object)) continue;
					if (!Modding.getDecorator<typeof Component>(object)) continue;

					componentDependencies.push(object as Constructor);
				}
			}

			components.set(ctor, {
				ctor: ctor as Constructor<BaseComponent>,
				config: args[0] || {},
				componentDependencies,
				identifier,
			});
		}
		this.components = components;
	}

	onStart() {
		for (const [, { config, ctor }] of this.components) {
			const ancestorBlacklist = config.ancestorBlacklist ?? DEFAULT_ANCESTOR_BLACKLIST;
			const ancestorWhitelist = config.ancestorWhitelist;

			if (config.tag !== undefined) {
				const tracker = this.getComponentTracker(ctor);
				const predicate = this.getConfigValue(ctor, "predicate");

				const listener = (isQualified: boolean, instance: Instance) => {
					if (isQualified) {
						this.addComponent(instance, ctor, true);
					} else {
						this.removeComponent(instance, ctor);
					}
				};

				const instanceAdded = (instance: Instance) => {
					if (predicate !== undefined && !predicate(instance)) {
						return;
					}

					const isWhitelisted = ancestorWhitelist?.some((ancestor) => instance.IsDescendantOf(ancestor));
					if (isWhitelisted === false) return;

					const isBlacklisted = ancestorBlacklist.some((ancestor) => instance.IsDescendantOf(ancestor));
					if (isBlacklisted && isWhitelisted === undefined) return;

					tracker.trackInstance(instance, listener);
					tracker.setHasTag(instance, true);
				};

				CollectionService.GetInstanceAddedSignal(config.tag).Connect(instanceAdded);
				CollectionService.GetInstanceRemovedSignal(config.tag).Connect((instance) => {
					tracker.untrackInstance(instance, listener);
					tracker.setHasTag(instance, false);
					this.removeComponent(instance, ctor);
				});

				for (const instance of CollectionService.GetTagged(config.tag)) {
					safeCall(
						[`[Flamework] Failed to instantiate '${ctor}' for`, instance, `[${instance.GetFullName()}]`],
						() => instanceAdded(instance),
						false,
					);
				}
			}
		}
	}

	private getComponentTracker(component: Constructor) {
		const existingTracker = this.trackers.get(component);
		if (existingTracker) return existingTracker;

		const componentInfo = this.components.get(component);
		assert(componentInfo, "Provided component does not exist");

		const instanceGuard = this.getConfigValue(component, "instanceGuard");
		const dependencies = new Array<ComponentTracker>();

		for (const dependency of componentInfo.componentDependencies) {
			dependencies.push(this.getComponentTracker(dependency));
		}

		const streamingMode = componentInfo.config.streamingMode ?? ComponentStreamingMode.Default;
		const tracker = new ComponentTracker(componentInfo.identifier, {
			tag: componentInfo.config.tag,
			typeGuard: instanceGuard,
			typeGuardPoll:
				(streamingMode === ComponentStreamingMode.Contextual && RunService.IsClient()) ||
				streamingMode === ComponentStreamingMode.Watching,
			typeGuardPollAtomic: streamingMode !== ComponentStreamingMode.Contextual,
			warningTimeout: componentInfo.config.warningTimeout,
			dependencies,
		});

		this.trackers.set(component, tracker);
		return tracker;
	}

	private getOrderedParents(ctor: AbstractConstructor, omitBaseComponent = true) {
		const cache = this.classParentCache.get(ctor);
		if (cache) return cache;

		const classes = [ctor];
		let nextParent: AbstractConstructor | undefined = ctor;
		while ((nextParent = getParentConstructor(nextParent)) !== undefined) {
			if (!omitBaseComponent || nextParent !== BaseComponent) {
				classes.push(nextParent);
			}
		}

		this.classParentCache.set(ctor, classes);
		return classes;
	}

	private getAttributeGuards(ctor: AbstractConstructor) {
		const attributes = new Map<string, t.check<unknown>>();
		const metadata = this.components.get(ctor as Constructor);
		if (metadata) {
			if (metadata.config.attributes !== undefined) {
				for (const [attribute, guard] of pairs(metadata.config.attributes)) {
					attributes.set(attribute as string, guard);
				}
			}
			const parentCtor = getmetatable(ctor) as { __index?: AbstractConstructor };
			if (parentCtor.__index !== undefined) {
				for (const [attribute, guard] of this.getAttributeGuards(parentCtor.__index)) {
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
		const defaults = this.getConfigValue(componentInfo.ctor, "defaults");

		for (const [key, guard] of pairs(guards)) {
			const attribute = attributes.get(key);
			if (!guard(attribute)) {
				if (defaults?.[key] !== undefined) {
					newAttributes.set(key, defaults[key]);
					instance.SetAttribute(key, defaults[key] as never);
				} else {
					throw `${instance.GetFullName()} has invalid attribute '${key}' for '${componentInfo.identifier}'`;
				}
			} else {
				newAttributes.set(key, attribute);
			}
		}

		return newAttributes;
	}

	private getConfigValue<T extends keyof ComponentConfig>(ctor: AbstractConstructor, key: T): ComponentConfig[T] {
		const metadata = this.components.get(ctor as Constructor);
		if (metadata) {
			if (metadata.config[key] !== undefined) {
				return metadata.config[key];
			}
			const parentCtor = getmetatable(ctor) as { __index?: AbstractConstructor };
			if (parentCtor.__index !== undefined) {
				return this.getConfigValue(parentCtor.__index, key);
			}
		}
	}

	private setupComponent(
		instance: Instance,
		attributes: Map<string, unknown>,
		component: BaseComponent,
		construct: () => void,
		{ ctor }: ComponentInfo,
	) {
		BaseComponent.setInstance(component, instance, attributes);
		construct();

		if (Flamework.implements<OnStart>(component)) {
			safeCall(
				[`[Flamework] Component '${ctor}' failed to start for`, instance, `[${instance.GetFullName()}]`],
				() => component.onStart(),
			);
		}

		Modding.addListener(component);
		component.maid.GiveTask(() => Modding.removeListener(component));

		const refreshAttributes = this.getConfigValue(ctor, "refreshAttributes");
		if (refreshAttributes === undefined || refreshAttributes) {
			const attributeCache = table.clone(attributes);
			const attributeGuards = this.getAttributeGuards(ctor);
			for (const [attribute, guard] of pairs(attributeGuards)) {
				if (typeIs(attribute, "string")) {
					component.maid.GiveTask(
						instance.GetAttributeChangedSignal(attribute).Connect(() => {
							const signal = component[SYMBOL_ATTRIBUTE_HANDLERS].get(attribute);
							const value = instance.GetAttribute(attribute);
							const attributes = component.attributes as Map<string, unknown>;
							if (guard(value)) {
								signal?.Fire(value, attributeCache.get(attribute));
								attributes.set(attribute, value);
								attributeCache.set(attribute, value);
							}
						}),
					);
				}
			}
		}

		const instanceWaiters = this.componentWaiters.get(instance);
		const componentWaiters = instanceWaiters?.get(ctor);
		if (componentWaiters) {
			instanceWaiters!.delete(ctor);

			if (instanceWaiters!.size() === 0) {
				this.componentWaiters.delete(instance);
			}

			for (const waiter of componentWaiters) {
				waiter(component);
			}
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

	private canCreateComponentEager(instance: Instance, component: Constructor) {
		const componentInfo = this.components.get(component);
		if (!componentInfo) return false;

		const tag = componentInfo.config.tag;
		if (tag !== undefined && instance.Parent && CollectionService.HasTag(instance, tag)) {
			const tracker = this.getComponentTracker(component);
			return tracker.checkInstance(instance);
		}
	}

	private getDependencyResolutionOptions(componentInfo: ComponentInfo, instance: Instance) {
		if (componentInfo.componentDependencies.isEmpty()) {
			return;
		}

		return {
			handle: (id: string) => {
				const ctor = Reflect.idToObj.get(id);
				if (ctor && isConstructor(ctor) && Modding.getDecorator<typeof Component>(ctor)) {
					const component = this.getComponent(instance, ctor);
					if (component === undefined) {
						const name = instance.GetFullName();
						throw `Could not resolve component '${id}' while constructing '${componentInfo.identifier}' (${name})`;
					}
					return component;
				}
			},
		};
	}

	/**
	 * This returns the specified component associated with the instance.
	 *
	 * The specified type must be exact and not a lifecycle event or superclass. If you want to
	 * query for lifecycle events or superclasses, you should use the `getComponents` method.
	 */
	getComponent<T extends object>(instance: Instance, componentSpecifier?: Constructor<T> | string): T | undefined {
		const component = getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		const activeComponents = this.activeComponents.get(instance);
		if (activeComponents) {
			const activeComponent = activeComponents.get(component);
			if (activeComponent) {
				return activeComponent as T;
			}
		}

		if (this.canCreateComponentEager(instance, component)) {
			return this.addComponent(instance, component, true);
		}
	}

	/**
	 * This returns all components associated with the instance that extend or implement the specified type.
	 *
	 * For example, `getComponents<OnTick>` will retrieve all components that subscribe to the OnTick lifecycle event.
	 */
	getComponents<T extends object>(instance: Instance, componentSpecifier?: AbstractConstructor<T> | string): T[] {
		const componentIdentifier = getIdFromSpecifier(componentSpecifier);
		if (componentIdentifier === undefined) return [];

		const activeComponents = this.activeInheritedComponents.get(instance);
		if (!activeComponents) return [];

		const componentsSet = activeComponents.get(componentIdentifier);
		if (!componentsSet) return [];

		return [...componentsSet] as never;
	}

	/** @internal */
	addComponent<T>(instance: Instance, componentSpecifier: Constructor<T>, skipInstanceCheck: true): T;

	/**
	 * Adds the specified component to the instance.
	 * The specified class must be exact and cannot be a lifecycle event or superclass.
	 */
	addComponent<T>(instance: Instance, componentSpecifier?: Constructor<T> | string): T;
	addComponent<T extends BaseComponent>(
		instance: Instance,
		componentSpecifier?: Constructor<T> | string,
		skipInstanceCheck?: boolean,
	) {
		const component = getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		const componentInfo = this.components.get(component);
		assert(componentInfo, "Provided componentSpecifier does not exist");

		const attributeGuards = this.getAttributeGuards(component);
		const attributes = this.getAttributes(instance, componentInfo, attributeGuards);

		if (skipInstanceCheck !== true) {
			const instanceGuard = this.getConfigValue(component, "instanceGuard");
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

		const resolutionOptions = this.getDependencyResolutionOptions(componentInfo, instance);
		const [componentInstance, construct] = Modding.createDeferredDependency(component, resolutionOptions);
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

	/**
	 * Removes the specified component from this instance.
	 * The specified class must be exact and cannot be a lifecycle event or superclass.
	 */
	removeComponent<T extends object>(instance: Instance, componentSpecifier?: Constructor<T> | string) {
		const component = getComponentFromSpecifier(componentSpecifier);
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

	/**
	 * This returns all components, across all instances, which extend or implement the specified type.
	 *
	 * For example, `getAllComponents<OnTick>` will retrieve all components that subscribe to the OnTick lifecycle event.
	 */
	getAllComponents<T extends object>(componentSpecifier?: AbstractConstructor<T> | string): T[] {
		const componentIdentifier = getIdFromSpecifier(componentSpecifier);
		if (componentIdentifier === undefined) return [];

		const reverseMapping = this.reverseComponentsMapping.get(componentIdentifier);
		if (!reverseMapping) return [];

		return [...reverseMapping] as never;
	}

	/**
	 * This returns a promise which will fire when the specified component is added.
	 * This will first call `getComponent` which means it can resolve instantly and will also
	 * have the eager loading capabilities of `getComponent`.
	 *
	 * This only fires once and should be cancelled to avoid memory leaks if the Promise is discarded prior to being invoked.
	 */
	waitForComponent<T extends object>(instance: Instance, componentSpecifier?: Constructor<T> | string): Promise<T> {
		const component = getComponentFromSpecifier(componentSpecifier);
		assert(component, `Could not find component from specifier: ${componentSpecifier}`);

		return new Promise((resolve, _, onCancel) => {
			const existingComponent = this.getComponent(instance, componentSpecifier);
			if (existingComponent !== undefined) return resolve(existingComponent);

			let instanceWaiters = this.componentWaiters.get(instance);
			if (!instanceWaiters) this.componentWaiters.set(instance, (instanceWaiters = new Map()));

			let componentWaiters = instanceWaiters.get(component);
			if (!componentWaiters) instanceWaiters.set(component, (componentWaiters = new Set()));

			onCancel(() => {
				componentWaiters!.delete(resolve as never);

				if (componentWaiters!.size() === 0) {
					instanceWaiters!.delete(component);
				}

				if (instanceWaiters!.size() === 0) {
					this.componentWaiters.delete(instance);
				}
			});

			componentWaiters.add(resolve as never);
		});
	}
}
