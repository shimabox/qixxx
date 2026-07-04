import { describe, it, expect } from 'vitest';
import { Field, UNCLAIMED, CLAIMED_FAST, CLAIMED_SLOW, BORDER } from './field';

describe('Field', () => {
  describe('initialization', () => {
    it('should initialize with correct dimensions', () => {
      const field = new Field(160, 120);
      expect(field.getWidth()).toBe(160);
      expect(field.getHeight()).toBe(120);
    });

    it('should have outer ring as BORDER cells', () => {
      const field = new Field(160, 120);

      // Check top and bottom edges
      for (let x = 0; x < 160; x++) {
        expect(field.get({ x, y: 0 })).toBe(BORDER);
        expect(field.get({ x, y: 119 })).toBe(BORDER);
      }

      // Check left and right edges
      for (let y = 0; y < 120; y++) {
        expect(field.get({ x: 0, y })).toBe(BORDER);
        expect(field.get({ x: 159, y })).toBe(BORDER);
      }
    });

    it('should have inner cells as UNCLAIMED', () => {
      const field = new Field(160, 120);

      // Sample some inner cells
      expect(field.get({ x: 1, y: 1 })).toBe(UNCLAIMED);
      expect(field.get({ x: 80, y: 60 })).toBe(UNCLAIMED);
      expect(field.get({ x: 158, y: 118 })).toBe(UNCLAIMED);
    });

    it('should calculate correct number of inner cells', () => {
      const field = new Field(160, 120);
      const unclaimedCells = field.getCellsOfState(UNCLAIMED);

      // Inner cells = (160 - 2) * (120 - 2) = 158 * 118 = 18644
      expect(unclaimedCells.length).toBe(158 * 118);
    });

    it('should have initial occupancy of 0%', () => {
      const field = new Field(160, 120);
      expect(field.getOccupancy()).toBe(0);
    });
  });

  describe('cell state manipulation', () => {
    it('should set and get cell states', () => {
      const field = new Field(160, 120);

      field.set({ x: 10, y: 10 }, CLAIMED_FAST);
      expect(field.get({ x: 10, y: 10 })).toBe(CLAIMED_FAST);

      field.set({ x: 20, y: 20 }, CLAIMED_SLOW);
      expect(field.get({ x: 20, y: 20 })).toBe(CLAIMED_SLOW);
    });

    it('should return BORDER for out of bounds access', () => {
      const field = new Field(160, 120);

      expect(field.get({ x: -1, y: 0 })).toBe(BORDER);
      expect(field.get({ x: 160, y: 0 })).toBe(BORDER);
      expect(field.get({ x: 0, y: -1 })).toBe(BORDER);
      expect(field.get({ x: 0, y: 120 })).toBe(BORDER);
    });

    it('should ignore out of bounds set operations', () => {
      const field = new Field(160, 120);

      field.set({ x: -1, y: 0 }, CLAIMED_FAST);
      field.set({ x: 160, y: 0 }, CLAIMED_FAST);

      // Grid should not change - checking occupancy remains 0
      expect(field.getOccupancy()).toBe(0);
    });

    it('should read cells with getAt consistently with get', () => {
      const field = new Field(160, 120);

      field.set({ x: 10, y: 10 }, CLAIMED_FAST);

      expect(field.getAt(10, 10)).toBe(CLAIMED_FAST);
      expect(field.getAt(0, 0)).toBe(BORDER);
      expect(field.getAt(1, 1)).toBe(UNCLAIMED);

      // Out of bounds behaves like get: returns BORDER
      expect(field.getAt(-1, 0)).toBe(BORDER);
      expect(field.getAt(160, 0)).toBe(BORDER);
      expect(field.getAt(0, -1)).toBe(BORDER);
      expect(field.getAt(0, 120)).toBe(BORDER);
    });
  });

  describe('occupancy calculation', () => {
    it('should increase occupancy when CLAIMED_FAST cells are added', () => {
      const field = new Field(160, 120);

      // Add some CLAIMED_FAST cells
      field.set({ x: 1, y: 1 }, CLAIMED_FAST);
      field.set({ x: 2, y: 1 }, CLAIMED_FAST);

      const occupancy = field.getOccupancy();
      const totalUnclaimed = 158 * 118;
      expect(occupancy).toBeCloseTo(2 / totalUnclaimed);
    });

    it('should increase occupancy when CLAIMED_SLOW cells are added', () => {
      const field = new Field(160, 120);

      field.set({ x: 1, y: 1 }, CLAIMED_SLOW);

      const occupancy = field.getOccupancy();
      const totalUnclaimed = 158 * 118;
      expect(occupancy).toBeCloseTo(1 / totalUnclaimed);
    });

    it('should count both CLAIMED_FAST and CLAIMED_SLOW equally', () => {
      const field = new Field(160, 120);

      field.set({ x: 1, y: 1 }, CLAIMED_FAST);
      field.set({ x: 2, y: 1 }, CLAIMED_SLOW);

      const occupancy = field.getOccupancy();
      const totalUnclaimed = 158 * 118;
      expect(occupancy).toBeCloseTo(2 / totalUnclaimed);
    });

    it('should return 0 occupancy for field with no unclaimed cells', () => {
      const field = new Field(1, 1);
      // 1x1 grid is all BORDER
      expect(field.getOccupancy()).toBe(0);
    });
  });

  describe('cell queries', () => {
    it('should return all cells with getAllCells', () => {
      const field = new Field(5, 5);
      const cells = field.getAllCells();

      expect(cells.length).toBe(25);
    });

    it('should return correct cells for getCellsOfState', () => {
      const field = new Field(160, 120);

      field.set({ x: 10, y: 10 }, CLAIMED_FAST);
      field.set({ x: 11, y: 10 }, CLAIMED_FAST);
      field.set({ x: 20, y: 20 }, CLAIMED_SLOW);

      const fastCells = field.getCellsOfState(CLAIMED_FAST);
      expect(fastCells.length).toBe(2);

      const slowCells = field.getCellsOfState(CLAIMED_SLOW);
      expect(slowCells.length).toBe(1);
    });
  });

  describe('field cloning', () => {
    it('should create independent clone', () => {
      const field1 = new Field(160, 120);
      field1.set({ x: 10, y: 10 }, CLAIMED_FAST);

      const field2 = field1.clone();
      expect(field2.get({ x: 10, y: 10 })).toBe(CLAIMED_FAST);

      field2.set({ x: 10, y: 10 }, CLAIMED_SLOW);
      expect(field1.get({ x: 10, y: 10 })).toBe(CLAIMED_FAST);
      expect(field2.get({ x: 10, y: 10 })).toBe(CLAIMED_SLOW);
    });
  });
});
