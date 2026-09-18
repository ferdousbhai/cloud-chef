import { atom, computed, map, type MapStore, type WritableAtom } from 'nanostores';
import type { EditorDocument, ScrollPosition } from 'cloudchef-agent/types';
import type { AbsolutePath } from 'cloudchef-agent/utils/workDir';
import { getAbsolutePath } from 'cloudchef-agent/utils/workDir';
import type { FileMap } from 'cloudchef-agent/types';

type EditorDocuments = Record<string, EditorDocument>;

type SelectedFile = WritableAtom<string | undefined>;

export class EditorStore {
  selectedFile: SelectedFile = import.meta.hot?.data.selectedFile ?? atom<AbsolutePath | undefined>();
  documents: MapStore<EditorDocuments> = import.meta.hot?.data.documents ?? map({});
  followingStreamedCode = atom<boolean>(true);

  currentDocument = computed([this.documents, this.selectedFile], (documents, selectedFile) =>
    selectedFile ? documents[selectedFile] : undefined,
  );

  constructor() {
    if (import.meta.hot) {
      import.meta.hot.data.documents = this.documents;
      import.meta.hot.data.selectedFile = this.selectedFile;
    }
  }

  setDocuments(files: FileMap, unsavedFiles: ReadonlySet<string> = new Set()) {
    const previousDocuments = this.documents.value;
    const documents: EditorDocuments = {};

    for (const [filePath, dirent] of Object.entries(files)) {
      if (dirent === undefined || dirent.type === 'folder') {
        continue;
      }

      documents[filePath] = {
        value: unsavedFiles.has(filePath) ? (previousDocuments?.[filePath]?.value ?? dirent.content) : dirent.content,
        isBinary: dirent.isBinary,
        filePath: getAbsolutePath(filePath),
        scroll: previousDocuments?.[filePath]?.scroll,
      };
    }

    this.documents.set(documents);
  }

  setSelectedFile(filePath: AbsolutePath | undefined) {
    this.selectedFile.set(filePath);
  }

  updateScrollPosition(filePath: string, position: ScrollPosition) {
    const documents = this.documents.get();
    const documentState = documents[filePath];

    if (!documentState) {
      return;
    }

    this.documents.setKey(filePath, {
      ...documentState,
      scroll: position,
    });
  }

  updateFile(filePath: string, newContent: string) {
    const documents = this.documents.get();
    const documentState = documents[filePath];

    if (!documentState) {
      return;
    }

    const currentContent = documentState.value;
    const contentChanged = currentContent !== newContent;

    if (contentChanged) {
      this.documents.setKey(filePath, {
        ...documentState,
        value: newContent,
      });
    }
  }
}
