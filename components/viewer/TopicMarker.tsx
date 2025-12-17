import React from 'react';
import { Topic } from '../../types';
import { cn } from '../../utils';
import { Flag, GitBranch } from 'lucide-react';

interface TopicMarkerProps {
  topic: Topic;
  onClick?: () => void;
}

export const TopicMarker: React.FC<TopicMarkerProps> = ({ topic, onClick }) => {
  const isTangent = topic.type === 'tangent';

  return (
    <div
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 py-1 px-3 mb-2 rounded-full text-xs font-medium w-fit cursor-pointer transition-colors select-none",
        isTangent
          ? "bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-200"
          : "bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200"
      )}
    >
      {isTangent ? <GitBranch size={12} /> : <Flag size={12} />}
      <span className="uppercase tracking-wide opacity-75 text-[10px]">
        {isTangent ? 'Tangent' : 'Topic'}
      </span>
      <span>{topic.title}</span>
    </div>
  );
};
