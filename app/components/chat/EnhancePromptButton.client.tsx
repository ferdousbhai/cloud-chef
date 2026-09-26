import { Button } from '@ui/Button';
import React from 'react';
import { Spinner } from '@ui/Spinner';
import { SparklesIcon } from '@heroicons/react/24/outline';

interface EnhancePromptButtonProps {
  isEnhancing?: boolean;
  disabled?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
}

export const EnhancePromptButton = React.memo(function EnhancePromptButton({
  isEnhancing,
  disabled,
  onClick,
}: EnhancePromptButtonProps) {
  return (
    <Button
      variant="neutral"
      tip="Refine your build plan"
      aria-label={isEnhancing ? 'Refining build plan' : 'Refine build plan'}
      aria-busy={isEnhancing}
      disabled={disabled || isEnhancing}
      inline
      size="xs"
      className="h-8 gap-1.5 px-2 text-xs font-normal"
      onClick={onClick}
    >
      {!isEnhancing ? <SparklesIcon className="size-4" aria-hidden /> : <Spinner className="size-4" />}
      <span>{isEnhancing ? 'Refining…' : 'Refine'}</span>
    </Button>
  );
});
