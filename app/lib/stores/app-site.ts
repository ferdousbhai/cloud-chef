import { atom } from 'nanostores';
import { idleBuilderPreviewState, type BuilderPreviewState } from '~/agents/builder-preview-types';
import type { BuilderPublicationState } from '~/agents/builder-publication-progress';

type PreviewActions = {
  request(): Promise<BuilderPreviewState>;
};

export class PreviewsStore {
  state = atom<BuilderPreviewState>(idleBuilderPreviewState());
  /** The step the running publication last recorded, for the wait the preview panel narrates. */
  publication = atom<BuilderPublicationState | null>(null);
  #actions: PreviewActions | null = null;

  connect(actions: PreviewActions): () => void {
    this.#actions = actions;
    return () => {
      if (this.#actions === actions) {
        this.#actions = null;
      }
    };
  }

  update(state: BuilderPreviewState): void {
    this.state.set(state);
  }

  updatePublication(publication: BuilderPublicationState | null): void {
    this.publication.set(publication);
  }

  reset(): void {
    this.#actions = null;
    this.state.set(idleBuilderPreviewState());
    this.publication.set(null);
  }

  request(): Promise<BuilderPreviewState> {
    return this.#requireActions().request();
  }

  #requireActions(): PreviewActions {
    if (!this.#actions) {
      throw new Error('The remote preview connection is not ready.');
    }
    return this.#actions;
  }
}
