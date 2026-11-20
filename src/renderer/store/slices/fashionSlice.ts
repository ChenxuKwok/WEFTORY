import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { FashionSnapshot } from '../../../shared/fashion/contracts';

type FashionState = { snapshot?: FashionSnapshot; runId: string };
const initialState: FashionState = { runId: '' };

const fashionSlice = createSlice({
  name: 'fashion',
  initialState,
  reducers: {
    receiveFashionSnapshot(state, action: PayloadAction<FashionSnapshot>) {
      state.snapshot = action.payload;
    },
    chooseFashionRun(state, action: PayloadAction<string>) {
      state.runId = action.payload;
    },
  },
});

export const { chooseFashionRun, receiveFashionSnapshot } = fashionSlice.actions;
export default fashionSlice.reducer;
