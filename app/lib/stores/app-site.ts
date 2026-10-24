import { atom } from 'nanostores';
import type { BuilderDeploymentState } from '~/agents/builder-deployment-command';
import type { BuilderPublicationState } from '~/agents/builder-publication-progress';
import { emptyAppSiteState, type AppSiteState } from '~/lib/common/app-site';

type AppSiteActions = {
  publish(): Promise<BuilderDeploymentState>;
};

export class AppSiteStore {
  state = atom<AppSiteState>(emptyAppSiteState());
  /** The step the running deployment last recorded, for the wait the preview pane narrates. */
  publication = atom<BuilderPublicationState | null>(null);
  #actions: AppSiteActions | null = null;

  connect(actions: AppSiteActions): () => void {
    this.#actions = actions;
    return () => {
      if (this.#actions === actions) {
        this.#actions = null;
      }
    };
  }

  update(state: AppSiteState): void {
    this.state.set(state);
  }

  updatePublication(publication: BuilderPublicationState | null): void {
    this.publication.set(publication);
  }

  reset(): void {
    this.#actions = null;
    this.state.set(emptyAppSiteState());
    this.publication.set(null);
  }

  publish(): Promise<BuilderDeploymentState> {
    return this.#requireActions().publish();
  }

  #requireActions(): AppSiteActions {
    if (!this.#actions) {
      throw new Error('The connection to the builder is not ready.');
    }
    return this.#actions;
  }
}
