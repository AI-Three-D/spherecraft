// js/GameInputManager.js
export class GameInputManager {
    constructor(canvas) {
        this.canvas = canvas;
        
        this.keys = new Set();
        this.mousePosition = { x: 0, y: 0 };
        this.mouseDelta = { x: 0, y: 0 };
        this.isLeftMouseDown = false;
        this.isRightMouseDown = false;
        this.wheelDelta = 0;
        
        this._lastMouseX = 0;
        this._lastMouseY = 0;
        
        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onWheel = this._onWheel.bind(this);
        this._onContextMenu = this._onContextMenu.bind(this);
    }

    start() {
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        
        this.canvas.addEventListener('mousemove', this._onMouseMove);
        this.canvas.addEventListener('mousedown', this._onMouseDown);
        this.canvas.addEventListener('mouseup', this._onMouseUp);
        this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
        this.canvas.addEventListener('contextmenu', this._onContextMenu);
    }

    stop() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        
        this.canvas.removeEventListener('mousemove', this._onMouseMove);
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        this.canvas.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('wheel', this._onWheel);
        this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    }

    _onKeyDown(event) {
        this.keys.add(event.code);
    }

    _onKeyUp(event) {
        this.keys.delete(event.code);
    }

    _onMouseMove(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        this.mouseDelta.x = x - this._lastMouseX;
        this.mouseDelta.y = y - this._lastMouseY;
        
        this._lastMouseX = x;
        this._lastMouseY = y;
        this.mousePosition.x = x;
        this.mousePosition.y = y;
    }

    _onMouseDown(event) {
        if (event.button === 0) {
            this.isLeftMouseDown = true;
        } else if (event.button === 2) {
            this.isRightMouseDown = true;
        }
        
        this._lastMouseX = event.clientX - this.canvas.getBoundingClientRect().left;
        this._lastMouseY = event.clientY - this.canvas.getBoundingClientRect().top;
        this.mouseDelta.x = 0;
        this.mouseDelta.y = 0;
    }

    _onMouseUp(event) {
        if (event.button === 0) {
            this.isLeftMouseDown = false;
        } else if (event.button === 2) {
            this.isRightMouseDown = false;
        }
    }

    _onWheel(event) {
        event.preventDefault();
        this.wheelDelta = event.deltaY;
    }
    
    _onContextMenu(event) {
        event.preventDefault();
    }
    
    getKeys() {
        const keyMap = {};
        for (const code of this.keys) {
            if (code.startsWith('Key')) {
                const letter = code.substring(3).toLowerCase();
                keyMap[letter] = true;
                keyMap[letter.toUpperCase()] = true;
            } else if (code.startsWith('Arrow')) {
                keyMap[code] = true;
            } else if (code === 'Space') {
                keyMap[' '] = true;
                keyMap['Space'] = true;
            } else if (code === 'ShiftLeft' || code === 'ShiftRight') {
                keyMap['Shift'] = true;
            } else if (code === 'ControlLeft' || code === 'ControlRight') {
                keyMap['Control'] = true;
            } else {
                keyMap[code] = true;
            }
        }
        return keyMap;
    }
    
    getMouseDelta() {
        const delta = { x: this.mouseDelta.x, y: this.mouseDelta.y };
        this.mouseDelta.x = 0;
        this.mouseDelta.y = 0;
        return delta;
    }
    
    getWheelDelta() {
        const delta = this.wheelDelta;
        this.wheelDelta = 0;
        return delta;
    }
    
    isDragging() {
        return this.isLeftMouseDown || this.isRightMouseDown;
    }
    
    isLeftDragging() {
        return this.isLeftMouseDown;
    }
    
    isRightDragging() {
        return this.isRightMouseDown;
    }
}