export class GameTime {

    constructor(gameEngine) {
        this.gameEngine = gameEngine; 
        this.dayDurationMs = 1 * 60 * 1000; // 24 minutes real time = 1 game day
        this.startDay = 190;
        this.currentDay = this.startDay;
        const startHour = 12; // Start near noon for brighter initial lighting
    
        const offsetMs = (startHour / 24) * this.dayDurationMs;
        this.dayStartTime = Date.now() - offsetMs;
        this.seasonData = [
            { name: 'Winter', length: 95 },
            { name: 'Spring', length: 90 },
            { name: 'Summer', length: 90 },
            { name: 'Autumn', length: 90 }
          ];
        this.timePeriods = [
            { name: "Night", startHour: 0, lightLevel: 0.3 },
            { name: "Dawn", startHour: 5, lightLevel: 0.6 },
            { name: "Morning", startHour: 7, lightLevel: 0.8 },
            { name: "Noon", startHour: 11, lightLevel: 1.0 },
            { name: "Afternoon", startHour: 14, lightLevel: 0.9 },
            { name: "Evening", startHour: 18, lightLevel: 0.7 },
            { name: "Dusk", startHour: 20, lightLevel: 0.5 },
            { name: "Night", startHour: 22, lightLevel: 0.3 }
        ];
        this.seasons = ['Spring', 'Summer', 'Autumn', 'Winter']; // or use your own names
    }

    getRunningSeasonInfo() {
        const totalSeasonLength = this.seasonData.reduce((sum, s) => sum + s.length, 0);
        const dayOfYear = (this.currentDay - 1) % totalSeasonLength; 
        let dayCounter = 0;
        for (const season of this.seasonData) {
            const seasonStart = dayCounter;                 // inclusive
            const seasonEnd   = seasonStart + season.length; // exclusive
            if (dayOfYear >= seasonStart && dayOfYear < seasonEnd) {
                // Days left *including today* in the current season.
                return [seasonEnd - dayOfYear, season];
            }
            dayCounter = seasonEnd;
        }
        return [this.seasonData[0].length, this.seasonData[0]]; // fallback, should not reach
    }

    update() {
        const elapsed = Date.now() - this.dayStartTime;
        const daysPassed = Math.floor(elapsed / this.dayDurationMs);
        this.currentDay = this.startDay + daysPassed;
        const dayProgress = (elapsed % this.dayDurationMs) / this.dayDurationMs;
        this.timeOfDay = dayProgress * 24;
    }
    getSeason() {
        const totalSeasonLength = this.seasonData.reduce((a, b) => a + b.length, 0);
        const dayOfYear = (this.currentDay - 1) % totalSeasonLength; // 0-indexed
    
        let daySum = 0;
        for (const season of this.seasonData) {
            if (dayOfYear < daySum + season.length) {
                return season.name;
            }
            daySum += season.length;
        }
        // fallback (should not reach)
        return this.seasonData[0].name;
    }

    getCurrentPeriod() {
        for (let i = this.timePeriods.length - 1; i >= 0; i--) {
            if (this.timeOfDay >= this.timePeriods[i].startHour) {
                return this.timePeriods[i];
            }
        }
        return this.timePeriods[0];
    }

    getLightLevel() {
        const currentPeriod = this.getCurrentPeriod();
        const nextPeriod = this.getNextPeriod();
        
        // Calculate transition between periods
        const currentHour = this.timeOfDay;
        const nextHour = nextPeriod.startHour;
        const progress = (currentHour - currentPeriod.startHour) / 
            (nextHour - currentPeriod.startHour);
        
        return this.lerp(
            currentPeriod.lightLevel,
            nextPeriod.lightLevel,
            progress
        );
    }

    getNextPeriod() {
        for (let i = 0; i < this.timePeriods.length; i++) {
            if (this.timePeriods[i].startHour > this.timeOfDay) {
                return this.timePeriods[i];
            }
        }
        return this.timePeriods[0];
    }

    lerp(start, end, progress) {
        return start + (end - start) * Math.max(0, Math.min(1, progress));
    }

    getTimeString() {
        const hours = Math.floor(this.timeOfDay);
        const minutes = Math.floor((this.timeOfDay % 1) * 60);
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }

    isNight() {
        return this.timeOfDay >= 20 || this.timeOfDay < 6;
    }

    // Add these methods to your GameTime class:

getSeasonInfo() {
    const [daysLeftInSeason, currentSeasonObj] = this.getRunningSeasonInfo();
    
    // Map season names to indices (0=Spring, 1=Summer, 2=Autumn, 3=Winter)
    const seasonNameToIndex = {
        'Spring': 0,
        'Summer': 1, 
        'Autumn': 2,
        'Winter': 3
    };
    
    const currentSeasonIndex = seasonNameToIndex[currentSeasonObj.name];
    const nextSeasonIndex = (currentSeasonIndex + 1) % 4;
    
    // Calculate transition progress (0.0 = start of season, 1.0 = end of season)
    const totalSeasonLength = currentSeasonObj.length;
    const daysIntoSeason = totalSeasonLength - daysLeftInSeason;
    const seasonProgress = daysIntoSeason / totalSeasonLength;
    
    // For smooth transitions, we want the transition to happen over the last 10% of the season
    const transitionThreshold = 0.9; // Start transitioning when 90% through season
    let transitionProgress = 0.0;
    
    if (seasonProgress >= transitionThreshold) {
        // Map the last 10% of season to 0.0-1.0 transition
        transitionProgress = (seasonProgress - transitionThreshold) / (1.0 - transitionThreshold);
    }
    
    return {
        currentSeason: currentSeasonIndex,
        nextSeason: nextSeasonIndex,
        transitionProgress: Math.min(transitionProgress, 1.0),
        seasonProgress: seasonProgress,
        daysLeftInSeason: daysLeftInSeason,
        currentSeasonName: currentSeasonObj.name,
        nextSeasonName: this.seasons[nextSeasonIndex]
    };
}

// Optional: Add a method to get current season as index directly
getCurrentSeasonIndex() {
    const seasonName = this.getSeason();
    const seasonNameToIndex = {
        'Spring': 0,
        'Summer': 1, 
        'Autumn': 2,
        'Winter': 3
    };
    return seasonNameToIndex[seasonName] || 0;
}

// Optional: Add debug method to see seasonal transitions
getSeasonDebugInfo() {
    const info = this.getSeasonInfo();
    return {
        day: this.currentDay,
        season: `${info.currentSeasonName} -> ${info.nextSeasonName}`,
        progress: `${(info.seasonProgress * 100).toFixed(1)}%`,
        transition: `${(info.transitionProgress * 100).toFixed(1)}%`,
        daysLeft: info.daysLeftInSeason
    };
}
}
