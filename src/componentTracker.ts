import Maid from "@rbxts/maid";
import { CollectionService } from "@rbxts/services";
import Signal from "@rbxts/signal";
import { t } from "@rbxts/t";

type Listener = (isQualified: boolean, instance: Instance) => void;

interface InstanceTracker {
	isQualified: boolean;
	unmetCriteria: Set<unknown>;
	listeners: Set<Listener>;
	cleanup: Set<Callback>;
}

export interface Criteria {
	tag?: string;
	typeGuard?: t.check<unknown>;
	typeGuardPoll?: boolean;
	dependencies?: ComponentTracker[];
}

export class ComponentTracker {
	private instances = new Map<Instance, InstanceTracker>();

	constructor(private criteria: Criteria) {}

	private getInstanceTracker(instance: Instance, create?: true): InstanceTracker;
	private getInstanceTracker(instance: Instance, create: false): InstanceTracker | undefined;
	private getInstanceTracker(instance: Instance, create = true) {
		let tracker = this.instances.get(instance);
		if (!tracker && create) {
			tracker = {
				unmetCriteria: new Set(),
				listeners: new Set(),
				cleanup: new Set(),
				isQualified: true,
			};
			this.instances.set(instance, tracker);
		}
		return tracker;
	}

	private updateListeners(instance: Instance, tracker: InstanceTracker) {
		const isQualified = tracker.unmetCriteria.isEmpty();
		if (isQualified !== tracker.isQualified) {
			tracker.isQualified = isQualified;
			for (const listener of tracker.listeners) {
				listener(isQualified, instance);
			}
		}
	}

	private setupTracker(instance: Instance, tracker: InstanceTracker) {
		const { typeGuard, typeGuardPoll, dependencies } = this.criteria;

		if (typeGuard && typeGuardPoll) {
			let addedConnection: RBXScriptConnection | undefined;
			let removingConnection: RBXScriptConnection | undefined;

			const connectAdded = () => {
				if (removingConnection) {
					removingConnection.Disconnect();
					removingConnection = undefined;
				}

				let isScheduled = false;
				addedConnection = instance.DescendantAdded.Connect(() => {
					if (!isScheduled) {
						isScheduled = true;
						task.defer(() => {
							isScheduled = false;

							if (typeGuard(instance)) {
								connectRemoving();
								tracker.unmetCriteria.delete("typeGuard");
								this.updateListeners(instance, tracker);
							}
						});
					}
				});
			};
			const connectRemoving = () => {
				if (addedConnection) {
					addedConnection.Disconnect();
					addedConnection = undefined;
				}

				let isScheduled = false;
				removingConnection = instance.DescendantRemoving.Connect(() => {
					if (!isScheduled) {
						isScheduled = true;
						task.defer(() => {
							isScheduled = false;

							if (!typeGuard(instance)) {
								connectAdded();
								tracker.unmetCriteria.add("typeGuard");
								this.updateListeners(instance, tracker);
							}
						});
					}
				});
			};

			tracker.cleanup.add(() => {
				addedConnection?.Disconnect();
				removingConnection?.Disconnect();
			});

			if (tracker.unmetCriteria.has("typeGuard")) {
				connectAdded();
			} else {
				connectRemoving();
			}
		}

		if (dependencies) {
			for (const dependency of dependencies) {
				const listener = (isQualified: boolean) => {
					if (isQualified) {
						tracker.unmetCriteria.delete(dependency);
					} else {
						tracker.unmetCriteria.add(dependency);
					}

					this.updateListeners(instance, tracker);
				};

				dependency.trackInstance(instance, listener);

				tracker.cleanup.add(() => {
					dependency.untrackInstance(instance, listener);
				});
			}
		}
	}

	private testInstance(instance: Instance, tracker?: InstanceTracker) {
		let result = true;
		if (this.criteria.dependencies) {
			for (const dependency of this.criteria.dependencies) {
				if (!dependency.checkInstance(instance)) {
					result = false;
					if (tracker) {
						tracker.unmetCriteria.add(dependency);
						this.updateListeners(instance, tracker);
					} else {
						return result;
					}
				}
			}
		}

		if (this.criteria.typeGuard) {
			if (!this.criteria.typeGuard(instance)) {
				result = false;
				if (tracker) {
					tracker.unmetCriteria.add("typeGuard");
					this.updateListeners(instance, tracker);
				} else {
					return result;
				}
			}
		}

		if (this.criteria.tag !== undefined) {
			if (!CollectionService.HasTag(instance, this.criteria.tag)) {
				result = false;
				if (tracker) {
					tracker.unmetCriteria.add("tag");
					this.updateListeners(instance, tracker);
				} else {
					return result;
				}
			}
		}

		return result;
	}

	/**
	 * Sets whether this instance has the required tag.
	 * This is called by Components for efficiency.
	 */
	public setHasTag(instance: Instance, hasTag: boolean) {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker) {
			if (hasTag) {
				tracker.unmetCriteria.delete("tag");
			} else {
				tracker.unmetCriteria.add("tag");
			}

			this.updateListeners(instance, tracker);
		}
	}

	public checkInstance(instance: Instance) {
		const tracker = this.getInstanceTracker(instance, false);

		if (tracker) {
			return tracker.isQualified;
		}

		return this.testInstance(instance, tracker);
	}

	public isTracked(instance: Instance) {
		return this.instances.has(instance);
	}

	public trackInstance(instance: Instance, listener: Listener) {
		const isNewInstance = !this.instances.has(instance);
		const tracker = this.getInstanceTracker(instance);
		if (isNewInstance) {
			this.testInstance(instance, tracker);
			this.setupTracker(instance, tracker);
		}

		tracker.listeners.add(listener);
		listener(tracker.isQualified, instance);
	}

	public untrackInstance(instance: Instance, listener: Listener) {
		const tracker = this.getInstanceTracker(instance, false);
		if (tracker) {
			tracker.listeners.delete(listener);

			if (tracker.listeners.isEmpty()) {
				for (const cleanup of tracker.cleanup) {
					cleanup();
				}

				this.instances.delete(instance);
			}
		}
	}
}
