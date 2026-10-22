import { useState, useEffect } from 'react';

/** Below this width the layout is the narrow one: chat and workbench share the screen in turns. */
const SMALL_VIEWPORT_MAX_WIDTH = 1024;

const useViewport = () => {
  const [isSmallViewport, setIsSmallViewport] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth < SMALL_VIEWPORT_MAX_WIDTH,
  );

  useEffect(() => {
    const handleResize = () => setIsSmallViewport(window.innerWidth < SMALL_VIEWPORT_MAX_WIDTH);
    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return isSmallViewport;
};

export default useViewport;
