const { wilsonScore, discoveryScore } = require('../utils/ranking');

describe('Ranking Utils', () => {
    describe('wilsonScore', () => {
        it('returns 0 for zero reviews', () => {
            expect(wilsonScore(5, 0)).toBe(0);
            expect(wilsonScore(5, undefined)).toBe(0);
        });

        it('a 5.0 rating with 2 reviews scores LOWER than a 4.8 rating with 200 reviews', () => {
            const lowVolumePerfect = wilsonScore(5, 2);
            const highVolumeImperfect = wilsonScore(4.8, 200);
            expect(lowVolumePerfect).toBeLessThan(highVolumeImperfect);
        });

        it('more reviews at the same rating increases confidence (higher score)', () => {
            const lowConfidence = wilsonScore(4, 10);
            const highConfidence = wilsonScore(4, 100);
            expect(lowConfidence).toBeLessThan(highConfidence);
        });

        it('score is always within a sane 0..1 range', () => {
            expect(wilsonScore(5, 100)).toBeGreaterThan(0);
            expect(wilsonScore(5, 100)).toBeLessThanOrEqual(1);
            expect(wilsonScore(0, 100)).toBeGreaterThanOrEqual(0);
            expect(wilsonScore(0, 100)).toBeLessThan(1);
        });
    });

    describe('discoveryScore', () => {
        it('discoveryScore volume boost cannot flip a materially better Wilson score', () => {
            // Very high rating/volume
            const betterWilson = discoveryScore({ averageRating: 4.9, reviewCount: 500, totalEscrows: 500 });
            // Lower rating but huge volume
            const hugeVolume = discoveryScore({ averageRating: 4.0, reviewCount: 100, totalEscrows: 10000 });
            
            expect(betterWilson).toBeGreaterThan(hugeVolume);
        });

        it('discoveryScore breaks ties in favor of higher volume when Wilson scores are equal', () => {
            const noEscrows = discoveryScore({ averageRating: 5, reviewCount: 10, totalEscrows: 0 });
            const someEscrows = discoveryScore({ averageRating: 5, reviewCount: 10, totalEscrows: 100 });
            expect(someEscrows).toBeGreaterThan(noEscrows);
        });
    });
});
