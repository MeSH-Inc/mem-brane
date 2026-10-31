import { z } from 'zod';

export const MAX_GROUP_LABEL = 60;
export const MAX_GROUP_MEMBERS = 200;
export const groupLabel = z.string().trim().min(1).max(MAX_GROUP_LABEL);
// A region draws a frame around its cards where they lie; a stack piles them into one
// card's space; a matrix sets machines' outputs in a table, a row per card they ran
// over and a column per machine. Whatever the display, the group feeds its members in
// member order.
export const GROUP_DISPLAYS = ['region', 'stack', 'matrix'] as const;
export const groupDisplay = z.enum(GROUP_DISPLAYS);
