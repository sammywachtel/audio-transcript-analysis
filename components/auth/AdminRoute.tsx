import React, { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';

interface AdminRouteProps {
  children: ReactNode;
  fallback?: ReactNode;
}

/**
 * AdminRoute - Gate admin-only content
 *
 * Renders children only if the current user has isAdmin=true in Firestore.
 * Shows fallback (or nothing) otherwise. Not a full redirect component -
 * just a simple conditional render for admin UI sections.
 */
export const AdminRoute: React.FC<AdminRouteProps> = ({ children, fallback = null }) => {
  const { isAdmin, loading } = useAuth();

  if (loading) return null;
  if (!isAdmin) return <>{fallback}</>;
  return <>{children}</>;
};
