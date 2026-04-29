import React from 'react';

interface CardProps {
    children: React.ReactNode;
    className?: string;
    glow?: boolean;
    hover?: boolean;
}

export const Card: React.FC<CardProps> = ({
    children,
    className = '',
    glow = false,
    hover = true,
}) => {
    return (
        <div className={`
      glass-card rounded-2xl p-6 transition-all duration-300
      ${glow ? 'glow-card' : ''}
      ${hover ? 'hover:-translate-y-1 hover:border-accent/30 hover:shadow-lg hover:shadow-accent/5' : ''}
      ${className}
    `}>
            {children}
        </div>
    );
};
