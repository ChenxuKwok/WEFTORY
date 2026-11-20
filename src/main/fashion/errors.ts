import { FashionError } from '../../shared/fashion/contracts';

export class FashionFailure extends Error {
  constructor(readonly code: FashionError) {
    super(code);
  }
}

export function fail(code: FashionError): never {
  throw new FashionFailure(code);
}
