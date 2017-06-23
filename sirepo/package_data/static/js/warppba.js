'use strict';

var srlog = SIREPO.srlog;
var srdbg = SIREPO.srdbg;

SIREPO.appLocalRoutes.dynamics = '/dynamics/:simulationId';
SIREPO.appDefaultSimulationValues.simulation.sourceType = 'laserPulse';

SIREPO.app.config(function($routeProvider, localRoutesProvider) {
    if (SIREPO.IS_LOGGED_OUT) {
        return;
    }
    var localRoutes = localRoutesProvider.$get();
    $routeProvider
        .when(localRoutes.source, {
            controller: 'WarpPBASourceController as source',
            templateUrl: '/static/html/warppba-source.html' + SIREPO.SOURCE_CACHE_KEY,
        })
        .when(localRoutes.dynamics, {
            controller: 'WarpPBADynamicsController as dynamics',
            templateUrl: '/static/html/warppba-dynamics.html' + SIREPO.SOURCE_CACHE_KEY,
        });
});

SIREPO.app.factory('warpPBAService', function(appState, $rootScope) {
    var self = {};
    self.laserGridDimensions = null;
    self.beamGridDimensions = null;

    function initGridDimensions() {
        if (self.laserGridDimensions)
            return;
        self.laserGridDimensions = appState.clone(SIREPO.APP_SCHEMA.enum.GridDimensions);
        self.beamGridDimensions = appState.clone(self.laserGridDimensions);
        self.laserGridDimensions.splice(2, 1);
        self.beamGridDimensions.splice(1, 1);
    }

    function isSourceType(sourceType) {
        if (appState.isLoaded())
            return appState.applicationState().simulation.sourceType == sourceType;
        return false;
    }

    self.isElectronBeam = function() {
        return isSourceType('electronBeam');
    };

    self.isLaserPulse = function() {
        return isSourceType('laserPulse');
    };

    appState.whenModelsLoaded($rootScope, function() {
        initGridDimensions();
        SIREPO.APP_SCHEMA.enum.GridDimensions = self.isLaserPulse()
            ? self.laserGridDimensions
            : self.beamGridDimensions;
    });
    return self;
});

SIREPO.app.controller('WarpPBADynamicsController', function(appState, frameCache, warpPBAService, persistentSimulation, $scope) {
    var self = this;
    self.model = 'animation';

    self.handleStatus = function(data) {
        frameCache.setFrameCount(data.frameCount);
        if (data.startTime) {
            ['fieldAnimation', 'particleAnimation', 'beamAnimation'].forEach(function(m) {
                appState.models[m].startTime = data.startTime;
                appState.saveQuietly(m);
            });
        }
    };

    self.getFrameCount = function() {
        return frameCache.getFrameCount();
    };

    self.isElectronBeam = function() {
        return warpPBAService.isElectronBeam();
    };

    persistentSimulation.initProperties(self, $scope, {
        fieldAnimation: [SIREPO.ANIMATION_ARGS_VERSION + '1', 'field', 'coordinate', 'mode', 'startTime'],
        particleAnimation: [SIREPO.ANIMATION_ARGS_VERSION + '1', 'x', 'y', 'histogramBins', 'xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax', 'uxMin', 'uxMax', 'uyMin', 'uyMax', 'uzMin', 'uzMax', 'startTime'],
        beamAnimation: [SIREPO.ANIMATION_ARGS_VERSION + '1', 'x', 'y', 'histogramBins', 'startTime'],
    });
});

SIREPO.app.controller('WarpPBASourceController', function(appState, frameCache, warpPBAService, $scope) {
    var self = this;
    $scope.appState = appState;
    var constants = {
        beamFactor: 0.728583,
        clight: 299792458.0,
        echarge: 1.602176565e-19,
        emass: 9.10938291e-31,
        eps0: 8.85418781762e-12,
    };

    function beamBunchLengthMethodChanged(newValue, oldValue) {
        if (! appState.isLoaded())
            return;
        var isAbsolute = appState.models.electronBeam.beamBunchLengthMethod == 'a';
        setVisibility(['electronBeam.rmsLength'], ! isAbsolute, oldValue);
        setReadOnly(['electronBeam.rmsLength'], true);
        setReadOnly(['electronBeam.bunchLength'], ! isAbsolute);
        recalcBeamBunchLength();
    }

    function beamRadiusMethodChanged(newValue, oldValue) {
        if (! appState.isLoaded())
            return;
        var isAbsolute = appState.models.electronBeam.beamRadiusMethod == 'a';
        setVisibility(['electronBeam.transverseEmittance'], ! isAbsolute, oldValue);
        setReadOnly(['electronBeam.rmsRadius'], ! isAbsolute);
        recalcRMSRadius();
    }

    function clearFrames() {
        //TODO(pjm): show a warning dialog before saving model if frame count > 10
        frameCache.clearFrames('animation');
    }

    function fieldClass(field) {
        return '.model-' + field.replace('.', '-');
    }

    function gridDimensionsChanged(newValue, oldValue) {
        if (! appState.isLoaded())
            return;
        var fields = {
            visible: ['simulationGrid.rScale', 'simulationGrid.zScale'],
            editable: ['simulationGrid.rLength', 'simulationGrid.zLength'],
        };
        var isAbsolute = appState.models.simulationGrid.gridDimensions == 'a';
        setVisibility(fields.visible, ! isAbsolute, oldValue);
        setReadOnly(fields.editable, ! isAbsolute);
        setReadOnly(['simulationGrid.rMin', 'simulationGrid.rMax', 'simulationGrid.zMin', 'simulationGrid.zMax', 'simulationGrid.rCount', 'simulationGrid.zCount'], true);
        var sourceFields = {
            laserPulse: ['simulationGrid.rCellsPerSpotSize', 'simulationGrid.zCellsPerWavelength'],
            electronBeam: ['simulationGrid.rCellResolution', 'simulationGrid.zCellResolution'],
        };
        setVisibility(sourceFields[self.isLaserPulse() ? 'laserPulse' : 'electronBeam'], true);
        setVisibility(sourceFields[self.isLaserPulse() ? 'electronBeam' : 'laserPulse'], false);
        recalcValues();
    }

    function lambdaLaser() {
        return appState.models.laserPulse.wavelength / 1e6;
    }

    function lambdaPlasma() {
        return 3.34e7 / Math.sqrt(appState.models.electronPlasma.density);
    }

    function pulseDimensionsChanged(newValue, oldValue) {
        if (! appState.isLoaded())
            return;
        var fields = {
            visible: ['laserPulse.length', 'laserPulse.spotSize'],
            editable: ['laserPulse.waist', 'laserPulse.duration'],
        };
        var isAbsolute = appState.models.laserPulse.pulseDimensions == 'a';
        setVisibility(fields.visible, ! isAbsolute, oldValue);
        setReadOnly(fields.editable, ! isAbsolute);
        recalcValues();
    }

    function recalcBeamBunchLength() {
        if (! appState.isLoaded())
            return;
        var isAbsolute = appState.models.electronBeam.beamBunchLengthMethod == 'a';
        if (isAbsolute)
            return;

        var fwMatched = 2 * lambdaPlasma();
        var rmsMax = lambdaPlasma() / Math.PI;
        var rmsLength = constants.beamFactor * rmsMax;
        var longNorm = 1 / (Math.sqrt(2 * Math.PI) * rmsLength);
        var xBunchHw = 3 * rmsLength;
        appState.models.electronBeam.rmsLength = rmsLength * 1e6;
        appState.models.electronBeam.bunchLength = 2 * xBunchHw * 1e6;
    }

    function recalcCellCount() {
        if (! appState.isLoaded())
            return;
        var grid = appState.models.simulationGrid;
        if (self.isLaserPulse()) {
            var laserPulse = appState.models.laserPulse;
            var lambda = lambdaLaser();
            grid.zCount = Math.round((grid.zMax - grid.zMin) / 1e6 * grid.zCellsPerWavelength / lambda);
            grid.rCount = Math.round((grid.rMax - grid.rMin) * grid.rCellsPerSpotSize / laserPulse.waist);
        }
        else {
            grid.zCount = Math.round(grid.zScale * grid.zCellResolution);
            grid.rCount = Math.round(grid.rScale * grid.rCellResolution);
        }
    }

    function recalcHistogramBins(newValue, oldValue) {
        if (! appState.isLoaded())
            return;
        if (newValue && oldValue) {
            appState.models.particleAnimation.histogramBins = newValue;
            //TODO(pjm): beam reports require a slight increase to match the grid
            appState.models.beamAnimation.histogramBins = newValue + 1;
            appState.models.beamPreviewReport.histogramBins = newValue + 1;
            appState.saveQuietly('particleAnimation');
            appState.saveQuietly('beamAnimation');
        }
    }

    function recalcLength() {
        if (! appState.isLoaded())
            return;
        var grid = appState.models.simulationGrid;
        grid.rMax = grid.rLength;
        grid.zMin = - grid.zLength;
    }

    function recalcRMSRadius(newValue, oldValue) {
        if (! appState.isLoaded())
            return;
        var isAbsolute = appState.models.electronBeam.beamRadiusMethod == 'a';
        if (isAbsolute)
            return;
        var kPe = 2 * Math.PI / lambdaPlasma();
        var twissBetaMatch = Math.sqrt(2) / kPe;
        appState.models.electronBeam.rmsRadius = Math.sqrt(twissBetaMatch * parseFloat(appState.models.electronBeam.transverseEmittance)) * 1e6;
    }

    function recalcValues() {
        if (! appState.isLoaded())
            return;
        var grid = appState.models.simulationGrid;
        if (self.isLaserPulse()) {
            var laserPulse = appState.models.laserPulse;
            var wplab = Math.sqrt(
                appState.models.electronPlasma.density
                    * Math.pow(constants.echarge, 2)
                    / (constants.eps0 * constants.emass));
            var kplab = wplab / constants.clight;
            // resonant wth plasma density
            if (laserPulse.pulseDimensions == 'r') {
                laserPulse.waist = (1e6 * laserPulse.spotSize / kplab).toFixed(12);
                laserPulse.duration = (1e12 * laserPulse.length / kplab / constants.clight).toFixed(12);
            }
            grid.rMin = 0;
            grid.zMax = (2.0 * lambdaLaser() * 1e6).toFixed(12);
            // scale to laser pulse
            if (grid.gridDimensions == 's') {
                grid.rLength = (grid.rScale * laserPulse.waist).toFixed(12);
                grid.zLength = (grid.zScale * laserPulse.duration / 1e6 * 4 * constants.clight).toFixed(12);
            }
        }
        else {
            var lambda = lambdaPlasma();
            grid.zMax = 0;
            if (grid.gridDimensions == 'e') {
                grid.rLength = 0.5 * grid.rScale * lambda * 1e6;
                grid.zLength = grid.zScale * lambda * 1e6;
            }
        }
        recalcLength();
        recalcCellCount();
        recalcRMSRadius();
        recalcBeamBunchLength();
    }

    function setReadOnly(fields, isReadOnly) {
        for (var i = 0; i < fields.length; i++) {
            $(fieldClass(fields[i]) + ' input').prop('readonly', isReadOnly);
        }
    }

    function setVisibility(fields, isVisible, oldValue) {
        for (var i = 0; i < fields.length; i++) {
            var el = $(fieldClass(fields[i])).closest('.form-group');
            if (isVisible) {
                if (oldValue)
                    el.slideDown();
            }
            else {
                if (oldValue)
                    el.slideUp();
                else
                    el.hide();
            }
        }
    }

    function updateFieldState() {
        gridDimensionsChanged();
        pulseDimensionsChanged();
        beamRadiusMethodChanged();
        beamBunchLengthMethodChanged();
    }

    self.isLaserPulse = function() {
        return warpPBAService.isLaserPulse();
    };

    self.isElectronBeam = function() {
        return warpPBAService.isElectronBeam();
    };

    $scope.$watch('appState.models.laserPulse.pulseDimensions', pulseDimensionsChanged);
    $scope.$watch('appState.models.laserPulse.length', recalcValues);
    $scope.$watch('appState.models.laserPulse.spotSize', recalcValues);
    $scope.$watch('appState.models.electronPlasma.density', recalcValues);
    $scope.$watch('appState.models.simulationGrid.gridDimensions', gridDimensionsChanged);
    $scope.$watch('appState.models.simulationGrid.rScale', recalcValues);
    $scope.$watch('appState.models.simulationGrid.zScale', recalcValues);
    $scope.$watch('appState.models.simulationGrid.rCellsPerSpotSize', recalcCellCount);
    $scope.$watch('appState.models.simulationGrid.zCellsPerWavelength', recalcCellCount);
    $scope.$watch('appState.models.simulationGrid.rCellResolution', recalcCellCount);
    $scope.$watch('appState.models.simulationGrid.zCellResolution', recalcCellCount);
    $scope.$watch('appState.models.simulationGrid.rLength', recalcLength);
    $scope.$watch('appState.models.simulationGrid.zLength', recalcLength);
    $scope.$watch('appState.models.laserPulse.duration', recalcValues);
    $scope.$watch('appState.models.laserPulse.wavelength', recalcValues);
    $scope.$watch('appState.models.simulationGrid.zCount', recalcHistogramBins);

    $scope.$watch('appState.models.electronBeam.beamRadiusMethod', beamRadiusMethodChanged);
    $scope.$watch('appState.models.electronBeam.beamBunchLengthMethod', beamBunchLengthMethodChanged);
    $scope.$watch('appState.models.electronBeam.transverseEmittance', recalcRMSRadius);

    $scope.$on('laserPulse.changed', clearFrames);
    $scope.$on('electronBeam.changed', clearFrames);
    $scope.$on('electronPlasma.changed', clearFrames);
    $scope.$on('simulationGrid.changed', clearFrames);

    $scope.$on(
        'laserPulse.changed',
        function() {
            appState.saveQuietly('simulationGrid');
        });
    $scope.$on(
        'electronPlasma.changed',
        function() {
            if (appState.models.laserPulse.pulseDimensions == 'r')
                appState.saveQuietly('laserPulse');
            appState.saveQuietly('simulationGrid');
        });
    appState.whenModelsLoaded($scope, updateFieldState);
});

SIREPO.app.directive('appFooter', function() {
    return {
        restrict: 'A',
        scope: {
            nav: '=appFooter',
        },
        template: [
        ].join(''),
    };
});

SIREPO.app.directive('appHeader', function(appState, panelState) {
    return {
        restrict: 'A',
        scope: {
            nav: '=appHeader',
        },
        template: [
            '<div class="navbar-header">',
              '<a class="navbar-brand" href="/#about" data-ng-click="nav.openSection(\'simulations\')"><img style="width: 40px; margin-top: -10px;" src="/static/img/radtrack.gif" alt="radiasoft"></a>',
            '<div class="navbar-brand"><a href data-ng-click="nav.openSection(\'simulations\')">',
            SIREPO.APP_SCHEMA.appInfo[SIREPO.APP_SCHEMA.simulationType].longName,
            '</a></div>',
            '</div>',
            '<div data-app-header-left="nav"></div>',
            '<ul class="nav navbar-nav navbar-right" data-login-menu=""></ul>',
            '<ul class="nav navbar-nav navbar-right" data-ng-show="isLoaded()">',
              '<li data-ng-class="{active: nav.isActive(\'source\')}"><a href data-ng-click="nav.openSection(\'source\')"><span class="glyphicon glyphicon-flash"></span> Source</a></li>',
              '<li data-ng-class="{active: nav.isActive(\'dynamics\')}"><a href data-ng-click="nav.openSection(\'dynamics\')"><span class="glyphicon glyphicon-option-horizontal"></span> Dynamics</a></li>',
            '</ul>',
            '<ul class="nav navbar-nav navbar-right" data-ng-show="nav.isActive(\'simulations\')">',
              '<li><a href data-ng-click="showSimulationModal()"><span class="glyphicon glyphicon-plus sr-small-icon"></span><span class="glyphicon glyphicon-file"></span> New Simulation</a></li>',
              '<li><a href data-ng-click="showNewFolderModal()"><span class="glyphicon glyphicon-plus sr-small-icon"></span><span class="glyphicon glyphicon-folder-close"></span> New Folder</a></li>',
            '</ul>',
        ].join(''),
        controller: function($scope) {
            $scope.isLoaded = function() {
                if ($scope.nav.isActive('simulations'))
                    return false;
                return appState.isLoaded();
            };
            $scope.showNewFolderModal = function() {
                panelState.showModalEditor('simulationFolder');
            };
            $scope.showSimulationModal = function() {
                panelState.showModalEditor('simulation');
            };
        },
    };
});