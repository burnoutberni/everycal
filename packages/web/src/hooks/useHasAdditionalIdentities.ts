import { useEffect, useState } from "react";
import { useAuth } from "./useAuth";
import {
  getCachedAdditionalIdentityCount,
  loadAdditionalIdentityCount,
} from "./additionalIdentitiesCache";

export type AdditionalIdentitiesState = {
  hasAdditionalIdentities: boolean;
  loading: boolean;
  error: string | null;
  count: number;
};

const EMPTY_STATE: AdditionalIdentitiesState = {
  hasAdditionalIdentities: false,
  loading: false,
  error: null,
  count: 0,
};

function fromCount(count: number, loading: boolean, error: string | null): AdditionalIdentitiesState {
  return {
    hasAdditionalIdentities: count > 0,
    loading,
    error,
    count,
  };
}

export function useHasAdditionalIdentities(): AdditionalIdentitiesState {
  const { user } = useAuth();
  const [state, setState] = useState<AdditionalIdentitiesState>(EMPTY_STATE);

  useEffect(() => {
    if (!user) {
      setState(EMPTY_STATE);
      return;
    }

    const userId = user.id;
    const cachedCount = getCachedAdditionalIdentityCount(userId);
    setState(fromCount(cachedCount ?? 0, cachedCount === undefined, null));

    let cancelled = false;
    loadAdditionalIdentityCount(userId)
      .then((count) => {
        if (cancelled) return;
        setState(fromCount(count, false, null));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : null;
        setState(fromCount(cachedCount ?? 0, false, message));
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  return state;
}
