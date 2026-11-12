import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Exempts a route or controller from the app-wide AuthGuard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
