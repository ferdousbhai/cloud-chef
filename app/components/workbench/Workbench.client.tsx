import { motion, MotionConfig, type HTMLMotionProps, type Variants } from 'framer-motion';
import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { IconButton } from '~/components/ui/IconButton';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import { Slider, type SliderOptions } from '~/components/ui/Slider';
import type { WorkbenchViewType } from '~/lib/stores/workbench.client';
import { classNames } from '~/utils/classNames';
import { cubicEasingFn } from '~/utils/easings';
import { renderLogger } from 'ghostbuild-agent/utils/logger';
import { EditorPanel } from './EditorPanel';
import { Cross2Icon, ReloadIcon } from '@radix-ui/react-icons';
import { useWorkbenchController } from './useWorkbenchController';
import { useStore } from '@nanostores/react';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { previewPresentation } from '~/lib/common/preview-presentation';
import { useWorkspaceSwipe } from '~/lib/hooks/useWorkspaceSwipe';

/** `--workbench-width` is a CSS custom property, which `CSSProperties` alone cannot express. */
const smallViewportWorkbenchStyle: CSSProperties & Record<`--${string}`, string> = {
  '--workbench-width': '100vw',
};

interface WorkbenchProps {
  chatStarted?: boolean;
  isStreaming?: boolean;
}

const viewTransition = { duration: 0.3, ease: cubicEasingFn };
const Preview = lazy(() => import('./Preview').then((module) => ({ default: module.Preview })));
const sliderOptions: SliderOptions<WorkbenchViewType> = {
  options: [
    {
      value: 'code',
      text: 'Code',
    },
    {
      value: 'preview',
      text: 'Preview',
    },
  ],
};

const workbenchVariants = {
  closed: {
    width: 0,
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
  open: {
    width: 'var(--workbench-width)',
    transition: {
      duration: 0.2,
      ease: cubicEasingFn,
    },
  },
} satisfies Variants;

export const Workbench = memo(function Workbench({ chatStarted, isStreaming }: WorkbenchProps) {
  renderLogger.trace('Workbench');
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const [hasMountedWorkbench, setHasMountedWorkbench] = useState(showWorkbench);

  useEffect(() => {
    if (showWorkbench) {
      setHasMountedWorkbench(true);
    }
  }, [showWorkbench]);

  if (!chatStarted || !hasMountedWorkbench) {
    return null;
  }

  return (
    <MotionConfig reducedMotion="user">
      <ReadyWorkbench isStreaming={isStreaming} />
    </MotionConfig>
  );
});

function ReadyWorkbench({ isStreaming }: Pick<WorkbenchProps, 'isStreaming'>) {
  const controller = useWorkbenchController(isStreaming);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const presentation = previewPresentation(controller.previewState);
  const publication = useStore(workbenchStore.publicationState);

  return (
    <WorkbenchFrame
      visible={controller.showWorkbench}
      selectedView={controller.selectedView}
      setSelectedView={controller.setSelectedView}
      isSmallViewport={controller.isSmallViewport}
      onClose={controller.close}
      lockedMessage={
        isStreaming ? 'Code and preview controls will be available as soon as the current build step finishes.' : null
      }
      headerActions={
        controller.selectedView === 'code' ? (
          <PanelHeaderButton className="mr-1 text-sm" onClick={() => void controller.onFileSave()}>
            Save
          </PanelHeaderButton>
        ) : (
          <>
            {presentation.isUpdatingVisible && (
              <span className="mr-2 text-xs text-content-secondary" aria-live="polite">
                Updating…
              </span>
            )}
            {presentation.canUpdate && (
              <PanelHeaderButton
                className="mr-1 text-sm"
                disabled={controller.previewRequesting}
                onClick={() => void controller.onPreviewRequest()}
              >
                Update
              </PanelHeaderButton>
            )}
            <IconButton
              icon={<ReloadIcon />}
              title="Reload preview frame"
              disabled={!presentation.canReload}
              onClick={() => setPreviewReloadKey((value) => value + 1)}
            />
          </>
        )
      }
    >
      <>
        <View {...slidingPosition({ view: 'code', selectedView: controller.selectedView })}>
          <EditorPanel
            projectId={controller.projectId}
            editorDocument={controller.currentDocument}
            isStreaming={isStreaming}
            scrollToDocAppend={controller.scrollToDocAppend}
            selectedFile={controller.selectedFile}
            files={controller.files}
            unsavedFiles={controller.unsavedFiles}
            onFileSelect={controller.onFileSelect}
            onEditorScroll={controller.onEditorScroll}
            onEditorWheel={controller.onEditorWheel}
            onEditorChange={controller.onEditorChange}
            onFileSave={controller.onFileSave}
            onFileReset={controller.onFileReset}
          />
        </View>
        <View {...slidingPosition({ view: 'preview', selectedView: controller.selectedView })}>
          {controller.hasLoadedPreview ? (
            <Suspense fallback={null}>
              <Preview
                presentation={presentation}
                publication={publication}
                reloadKey={previewReloadKey}
                requesting={controller.previewRequesting}
                onRequest={() => void controller.onPreviewRequest()}
                error={controller.previewState.error}
              />
            </Suspense>
          ) : (
            <div />
          )}
        </View>
      </>
    </WorkbenchFrame>
  );
}

function WorkbenchFrame({
  visible,
  selectedView,
  setSelectedView,
  isSmallViewport,
  onClose,
  lockedMessage,
  headerActions,
  children,
}: {
  visible: boolean;
  selectedView: WorkbenchViewType;
  setSelectedView: (view: WorkbenchViewType) => void;
  isSmallViewport: boolean;
  onClose: () => void;
  lockedMessage?: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  const workspaceSwipe = useWorkspaceSwipe(isSmallViewport);
  return (
    <motion.div
      initial="closed"
      animate={visible ? 'open' : 'closed'}
      variants={workbenchVariants}
      className={classNames('z-workbench', { 'pointer-events-none': !visible })}
      style={isSmallViewport ? smallViewportWorkbenchStyle : undefined}
      role="complementary"
      aria-label="Project workbench"
      aria-hidden={!visible}
      inert={!visible}
    >
      <motion.div
        initial={isSmallViewport ? { x: '100%' } : false}
        animate={{ x: isSmallViewport && !visible ? '100%' : '0%' }}
        transition={viewTransition}
        className={classNames('fixed z-0 transition-[left,width] duration-200 bolt-ease-cubic-bezier', {
          invisible: !visible && !isSmallViewport,
          'inset-x-0 top-[var(--header-height)] bottom-0 w-full': isSmallViewport,
          'left-[var(--workbench-left)] top-[calc(var(--header-height)+1rem)] bottom-four w-[var(--workbench-inner-width)]':
            !isSmallViewport,
        })}
      >
        <div className={classNames('absolute inset-0', { 'px-2 lg:px-6': !isSmallViewport })}>
          <div
            className={classNames('relative flex h-full flex-col overflow-hidden bg-bolt-elements-background-depth-2', {
              'rounded-lg border border-border-transparent shadow-panel': !isSmallViewport,
            })}
          >
            <div
              className={classNames('flex items-center border-b border-border-transparent', {
                'relative min-h-11 justify-end px-2 py-1 touch-pan-y touch-pinch-zoom': isSmallViewport,
                'px-3 py-2.5': !isSmallViewport,
              })}
              {...(isSmallViewport ? workspaceSwipe : {})}
            >
              {isSmallViewport && (
                <div
                  className="pointer-events-none absolute top-1.5 left-1/2 h-1 w-8 -translate-x-1/2 rounded-full bg-bolt-elements-borderColor"
                  aria-hidden
                />
              )}
              {!isSmallViewport && (
                <>
                  <Slider selected={selectedView} options={sliderOptions} setSelected={setSelectedView} />
                  <div className="ml-auto" />
                </>
              )}
              <div className={classNames({ 'ml-auto': isSmallViewport })} inert={Boolean(lockedMessage)}>
                {headerActions}
              </div>
              {!isSmallViewport && (
                <IconButton icon={<Cross2Icon />} className="-mr-1" title="Close workbench" onClick={onClose} />
              )}
            </div>
            <div className="relative flex-1 overflow-hidden">
              <div className="size-full" inert={Boolean(lockedMessage)}>
                {children}
              </div>
              {lockedMessage && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-bolt-elements-background-depth-2 px-6 text-center text-sm text-content-secondary">
                  {lockedMessage}
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

interface ViewProps extends HTMLMotionProps<'div'> {
  children: ReactElement;
}

const View = memo(function View({ children, ...props }: ViewProps) {
  return (
    <motion.div className="absolute inset-0" transition={viewTransition} {...props}>
      {children}
    </motion.div>
  );
});

function slidingPosition({ view, selectedView }: { view: WorkbenchViewType; selectedView: WorkbenchViewType }) {
  const tabsInOrder: WorkbenchViewType[] = ['code', 'preview'];

  const viewIndex = tabsInOrder.indexOf(view);
  const selectedViewIndex = tabsInOrder.indexOf(selectedView);

  const position = { x: `${(viewIndex - selectedViewIndex) * 100}%` };

  return {
    initial: position,
    animate: position,
  } satisfies Partial<ViewProps>;
}
