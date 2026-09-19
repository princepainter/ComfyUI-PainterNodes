"""
PainterSigmasGraph - Painter/Sigmas

改造自 ComfyUI_Element_easy 的 Element_SigmaGraph_Curve
（原始来源 TWanSigmaGraph, 原作者 Temult, MIT License）。

改动说明:
- 去掉 custom_sigmas / latent 两个输入口
- 去掉 steps 输出口，只保留一个 sigmas 输出口
- 选项改为: 步数 / 起始步数 / 预设(下拉菜单，纯前端)
- 去掉 max_value，输出范围固定 0 ~ 1
- 起始步数: 丢弃曲线前 start_step 个 sigma，即采样从第 start_step 步开始
"""

import os
import json
import re
import math

import torch


# ==========================================================
# 预设文件
# ==========================================================
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_PRESETS_DIR = os.path.join(_BASE_DIR, "presets")
_PRESETS_FILE = os.path.join(_PRESETS_DIR, "PainterSigmasGraph_presets.json")


def _load_presets():
    """读取预设列表，格式: [{"name": str, "points": str, "steps": int, "start_step": int}, ...]"""
    if not os.path.exists(_PRESETS_FILE):
        return []
    try:
        with open(_PRESETS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[PainterSigmasGraph] 读取预设文件失败: {e}")
        return []

    if isinstance(data, list):
        return [p for p in data if isinstance(p, dict) and p.get("name")]

    # 兼容 {"名字": {...}} 的字典写法
    if isinstance(data, dict):
        out = []
        for name, val in data.items():
            if isinstance(val, dict):
                item = dict(val)
                item.setdefault("name", name)
                out.append(item)
        return out
    return []


def _write_presets(presets):
    os.makedirs(_PRESETS_DIR, exist_ok=True)
    with open(_PRESETS_FILE, "w", encoding="utf-8") as f:
        json.dump(presets, f, indent=4, ensure_ascii=False)


def _upsert_preset(name, preset):
    name = str(name).strip()
    if not name:
        raise ValueError("预设名称不能为空")

    presets = _load_presets()
    item = dict(preset) if isinstance(preset, dict) else {}
    item["name"] = name

    for i, p in enumerate(presets):
        if p.get("name") == name:
            presets[i] = item
            break
    else:
        presets.append(item)

    _write_presets(presets)
    return presets


def _delete_preset(name):
    name = str(name).strip()
    presets = [p for p in _load_presets() if p.get("name") != name]
    _write_presets(presets)
    return presets


# ==========================================================
# 节点
# ==========================================================
class PainterSigmasGraph:
    EPSILON = 1e-6

    @classmethod
    def INPUT_TYPES(cls):
        default_points = json.dumps({
            "points": [{"x": 0.0, "y": 1.0}, {"x": 1.0, "y": 0.0}],
            "mode": "curve",
        })
        return {
            "required": {
                "steps": ("INT", {
                    "default": 20, "min": 1, "max": 1000,
                    "tooltip": "总步数（曲线被均分成 steps 段，共产生 steps+1 个 sigma）",
                }),
                "start_step": ("INT", {
                    "default": 0, "min": 0, "max": 1000,
                    "tooltip": "起始步数：丢弃曲线前 start_step 个 sigma，输出从这一步开始的 sigma 序列",
                }),
                "graph_data": ("STRING", {
                    "default": default_points,
                    "multiline": True,
                }),
            },
        }

    RETURN_TYPES = ("SIGMAS",)
    RETURN_NAMES = ("sigmas",)
    FUNCTION = "calculate_sigmas"
    CATEGORY = "Painter/Sigmas"

    # ---------------- 曲线数据解析 ----------------
    def _validate_and_clean_points(self, points_data_str):
        """解析 / 校验曲线控制点，统一返回 (points, is_curve)"""
        default_points_list = [{"x": 0.0, "y": 1.0}, {"x": 1.0, "y": 0.0}]
        is_curve = True

        try:
            points_data = json.loads(points_data_str)
            if isinstance(points_data, dict) and "points" in points_data:
                is_curve = (points_data.get("mode", "curve") == "curve")
                points_data = points_data["points"]
            elif not isinstance(points_data, list):
                raise ValueError("Graph data is not a list or valid dict.")
        except json.JSONDecodeError:
            try:
                nums_str = re.findall(r"-?\d+\.?\d*", points_data_str)
                nums = [float(n) for n in nums_str]
                if not nums:
                    raise ValueError("No valid numbers found in string.")
                if len(nums) == 1:
                    points_data = [{"x": 0.0, "y": nums[0]}, {"x": 1.0, "y": 0.0}]
                else:
                    points_data = [
                        {"x": float(i) / (len(nums) - 1), "y": float(y)}
                        for i, y in enumerate(nums)
                    ]
            except Exception as e:
                print(f"[PainterSigmasGraph Warning] Invalid graph_data format: {e}. Using default points.")
                return default_points_list, True
        except (ValueError, TypeError) as e:
            print(f"[PainterSigmasGraph Warning] Invalid graph_data: {e}. Using default points.")
            return default_points_list, True

        try:
            valid_points = []
            for p in points_data:
                if isinstance(p, dict) and "x" in p and "y" in p and \
                   isinstance(p["x"], (int, float)) and not math.isnan(p["x"]) and not math.isinf(p["x"]) and \
                   isinstance(p["y"], (int, float)) and not math.isnan(p["y"]) and not math.isinf(p["y"]):
                    y_clamped = max(0.0, min(1.0, float(p["y"])))
                    valid_points.append({"x": float(p["x"]), "y": y_clamped})
                else:
                    print(f"[PainterSigmasGraph Warning] Ignoring invalid point data: {p}")
        except Exception as e:
            print(f"[PainterSigmasGraph Warning] Error processing points: {e}. Using default.")
            return default_points_list, is_curve

        if not valid_points:
            return default_points_list, is_curve

        points = valid_points
        has_start = any(abs(p["x"] - 0.0) < self.EPSILON for p in points)
        has_end = any(abs(p["x"] - 1.0) < self.EPSILON for p in points)

        if not has_start:
            start_y = min(points, key=lambda p: abs(p["x"] - 0.0))["y"]
            points.append({"x": 0.0, "y": max(0.0, min(1.0, start_y))})
        if not has_end:
            end_y = min(points, key=lambda p: abs(p["x"] - 1.0))["y"]
            points.append({"x": 1.0, "y": max(0.0, min(1.0, end_y))})

        points.sort(key=lambda p: p["x"])

        unique_points = []
        if points:
            unique_points.append(points[0])
            last_x = points[0]["x"]
            for i in range(1, len(points)):
                if abs(points[i]["x"] - last_x) > self.EPSILON:
                    unique_points.append(points[i])
                    last_x = points[i]["x"]

        if len(unique_points) < 2:
            return default_points_list, is_curve

        return unique_points, is_curve

    # ---------------- 插值 ----------------
    def _linear_interpolate(self, x_query, points):
        if not points:
            return 0.0
        if x_query <= points[0]["x"]:
            return max(0.0, min(1.0, points[0]["y"]))
        if x_query >= points[-1]["x"]:
            return max(0.0, min(1.0, points[-1]["y"]))

        for i in range(len(points) - 1):
            p0 = points[i]
            p1 = points[i + 1]
            if p0["x"] <= x_query <= p1["x"]:
                t = (x_query - p0["x"]) / (p1["x"] - p0["x"])
                y = p0["y"] + t * (p1["y"] - p0["y"])
                return max(0.0, min(1.0, y))
        return max(0.0, min(1.0, points[-1]["y"]))

    def _cubic_spline_coefficients(self, points):
        n = len(points) - 1
        if n < 1:
            return []

        x = [p["x"] for p in points]
        y = [p["y"] for p in points]
        h = [x[i + 1] - x[i] for i in range(n)]

        A = [[0.0] * (n + 1) for _ in range(n + 1)]
        b = [0.0] * (n + 1)

        A[0][0] = 1.0
        A[n][n] = 1.0

        for i in range(1, n):
            A[i][i - 1] = h[i - 1]
            A[i][i] = 2.0 * (h[i - 1] + h[i])
            A[i][i + 1] = h[i]
            b[i] = 3.0 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1])

        M = self._solve_tridiagonal(A, b)

        coeffs = []
        for i in range(n):
            a = y[i]
            b_coef = (y[i + 1] - y[i]) / h[i] - h[i] * (2 * M[i] + M[i + 1]) / 3.0
            c = M[i]
            d = (M[i + 1] - M[i]) / (3.0 * h[i])
            coeffs.append({"a": a, "b": b_coef, "c": c, "d": d, "x0": x[i], "x1": x[i + 1]})

        return coeffs

    def _solve_tridiagonal(self, A, b):
        """Thomas 算法解三对角矩阵"""
        n = len(b)
        c_prime = [0.0] * n
        d_prime = [0.0] * n
        x = [0.0] * n

        c_prime[0] = A[0][1] / A[0][0] if n > 1 else 0
        d_prime[0] = b[0] / A[0][0]

        for i in range(1, n):
            denom = A[i][i] - A[i][i - 1] * c_prime[i - 1]
            if denom == 0:
                denom = 1e-12
            if i < n - 1:
                c_prime[i] = A[i][i + 1] / denom
            d_prime[i] = (b[i] - A[i][i - 1] * d_prime[i - 1]) / denom

        x[n - 1] = d_prime[n - 1]
        for i in range(n - 2, -1, -1):
            x[i] = d_prime[i] - c_prime[i] * x[i + 1]

        return x

    def _evaluate_spline(self, x_query, coeffs, points):
        if not coeffs:
            return 0.0

        for coeff in coeffs:
            if coeff["x0"] <= x_query <= coeff["x1"] or \
               abs(x_query - coeff["x0"]) < self.EPSILON or \
               abs(x_query - coeff["x1"]) < self.EPSILON:
                dx = x_query - coeff["x0"]
                y = coeff["a"] + coeff["b"] * dx + coeff["c"] * dx * dx + coeff["d"] * dx * dx * dx
                return max(0.0, min(1.0, y))

        if x_query < coeffs[0]["x0"]:
            return max(0.0, min(1.0, points[0]["y"]))
        return max(0.0, min(1.0, points[-1]["y"]))

    @staticmethod
    def _format_sigma_value(val):
        if abs(val) < 1e-10:
            val = 0.0
        val = max(0.0, min(1.0, val))
        return round(val, 10)

    # ---------------- 主函数 ----------------
    def calculate_sigmas(self, steps, start_step, graph_data):
        steps = max(1, int(steps))
        start_step = max(0, min(int(start_step), steps - 1))

        points, is_curve = self._validate_and_clean_points(graph_data)

        coeffs = self._cubic_spline_coefficients(points) if is_curve else []

        sigma_values = []
        for i in range(steps + 1):
            step_progress = min(1.0, max(0.0, i / steps))
            if is_curve:
                sigma = self._evaluate_spline(step_progress, coeffs, points)
            else:
                sigma = self._linear_interpolate(step_progress, points)
            sigma_values.append(self._format_sigma_value(sigma))

        # 保证严格递减（与原节点一致）
        sigma_values.sort(reverse=True)
        for i in range(len(sigma_values) - 2, -1, -1):
            if sigma_values[i] <= sigma_values[i + 1]:
                sigma_values[i] = sigma_values[i + 1] + 1e-5

        # 起始步数：丢掉前面的 sigma
        if start_step > 0:
            sigma_values = sigma_values[start_step:]

        if len(sigma_values) < 2:
            sigma_values = [1.0, 0.0]

        sigmas_tensor = torch.tensor(sigma_values, dtype=torch.float32, device="cpu")
        return (sigmas_tensor,)


NODE_CLASS_MAPPINGS = {"PainterSigmasGraph": PainterSigmasGraph}
NODE_DISPLAY_NAME_MAPPINGS = {"PainterSigmasGraph": "Painter Sigmas Graph"}


# ==========================================================
# 预设存取 API（与前端交互）
# ==========================================================
def _register_preset_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return False

    routes = getattr(getattr(PromptServer, "instance", None), "routes", None)
    if routes is None:
        return False
    if getattr(_register_preset_routes, "_registered", False):
        return True

    @routes.get("/painter/sigmas_graph/presets")
    async def _get_presets(request):
        return web.json_response({"presets": _load_presets()})

    @routes.post("/painter/sigmas_graph/presets")
    async def _post_presets(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"status": "error", "message": "Invalid JSON body"}, status=400)

        action = str(data.get("action") or "save").lower()
        try:
            if action == "delete":
                presets = _delete_preset(data.get("name"))
            else:
                presets = _upsert_preset(data.get("name"), data.get("preset"))
        except Exception as e:
            print(f"[PainterSigmasGraph] 保存预设失败: {e}")
            return web.json_response({"status": "error", "message": str(e)}, status=500)

        return web.json_response({"status": "success", "presets": presets})

    _register_preset_routes._registered = True
    return True


_register_preset_routes()
